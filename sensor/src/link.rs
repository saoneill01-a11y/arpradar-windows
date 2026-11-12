//! The sensor's Bluetooth protocol, shared by the Pi (server) and the apps (clients). Plain Rust, so it's tested on
//! any computer; the Bluetooth plumbing itself is in ble.rs (Linux only).
//!
//! Ownership works like adopting a UniFi device: the first app to connect becomes the owner, and the sensor then
//! ignores every other app until the owner releases it (or the SD card gets a `reset` file). Nobody types a code.
//!
//! One GATT service with three characteristics:
//!   INFO     read    {"v":2,"name","version","id","owned","claimPub","nonce","busy"}   (nothing secret)
//!   COMMAND  write   claim:   0xC1 ‖ app's X25519 public key (32)        (only while not owned)
//!                    command: nonce(16) ‖ iv(12) ‖ AES-256-GCM(key, iv, command JSON)
//!   EVENTS   notify  frames of: iv(12) ‖ AES-256-GCM(key, iv, event JSON)
//!
//! Claim: the sensor shows a fresh X25519 public key in INFO while it has no owner; the app answers with its own.
//! Both work out the same shared secret, and owner = HMAC-SHA256(shared, "arpradar-owner-v1"). The app keeps it in
//! the Keychain; the sensor keeps it in /var/lib/arpradar-sensor/owner.
//! key = HMAC-SHA256(owner, "arpradar-sensor-v1" ‖ nonce). The nonce in INFO changes after every accepted command,
//! so a recorded command can't be replayed. Events are sealed with the key of the last command.
//!
//! Events are longer than one Bluetooth packet, so each is sent as frames: [flags][bytes…], flags bit 0 = first
//! frame, bit 1 = last frame.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub const SERVICE: &str = "41525052-4144-4152-0000-000000000001";
pub const INFO: &str = "41525052-4144-4152-0000-000000000002";
pub const COMMAND: &str = "41525052-4144-4152-0000-000000000003";
pub const EVENTS: &str = "41525052-4144-4152-0000-000000000004";

pub const CLAIM: u8 = 0xC1;

pub type Secret = [u8; 32];

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).expect("random numbers");
    b
}

fn hmac(key: &[u8], parts: &[&[u8]]) -> Secret {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// A new X25519 key pair: (private, public).
pub fn keypair() -> (x25519_dalek::StaticSecret, [u8; 32]) {
    let private = x25519_dalek::StaticSecret::from(random::<32>());
    let public = x25519_dalek::PublicKey::from(&private).to_bytes();
    (private, public)
}

/// The owner secret both sides arrive at from a claim.
pub fn owner_secret(mine: &x25519_dalek::StaticSecret, their_public: &[u8; 32]) -> Secret {
    let shared = mine.diffie_hellman(&x25519_dalek::PublicKey::from(*their_public));
    hmac(shared.as_bytes(), &[b"arpradar-owner-v1"])
}

pub fn claim_bytes(app_public: &[u8; 32]) -> Vec<u8> {
    [&[CLAIM][..], app_public].concat()
}

/// The app's public key, if these bytes are a claim.
pub fn as_claim(bytes: &[u8]) -> Option<[u8; 32]> {
    (bytes.len() == 33 && bytes[0] == CLAIM).then(|| bytes[1..].try_into().unwrap())
}

pub fn key(owner: &Secret, nonce: &[u8; 16]) -> Secret {
    hmac(owner, &[b"arpradar-sensor-v1", nonce])
}

/// iv ‖ ciphertext (with tag).
pub fn seal(key: &Secret, plain: &[u8]) -> Vec<u8> {
    let iv = random::<12>();
    let ct = Aes256Gcm::new(key.into()).encrypt(Nonce::from_slice(&iv), plain).expect("encrypt");
    [iv.as_slice(), &ct].concat()
}

/// None when the key is wrong (not the owner, or an old nonce) or the bytes were changed.
pub fn open(key: &Secret, sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < 12 + 16 {
        return None;
    }
    Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(&sealed[..12]), &sealed[12..]).ok()
}

/// A command as written to COMMAND: nonce ‖ sealed JSON.
pub fn command_bytes(owner: &Secret, nonce: &[u8; 16], cmd: &Command) -> Vec<u8> {
    let json = serde_json::to_vec(cmd).expect("json");
    [nonce.as_slice(), &seal(&key(owner, nonce), &json)].concat()
}

/// The sensor's side: the command, if it came from the owner and uses the current nonce.
pub fn read_command(owner: &Secret, current_nonce: &[u8; 16], bytes: &[u8]) -> Result<Command, &'static str> {
    if bytes.len() < 16 || bytes[..16] != current_nonce[..] {
        return Err("stale");
    }
    let plain = open(&key(owner, current_nonce), &bytes[16..]).ok_or("not the owner")?;
    serde_json::from_slice(&plain).map_err(|_| "bad command")
}

/// Splits one message into notification-sized frames (`max` bytes each, flag byte included).
pub fn frames(message: &[u8], max: usize) -> Vec<Vec<u8>> {
    let size = max.max(8) - 1;
    let parts: Vec<&[u8]> = if message.is_empty() { vec![&[][..]] } else { message.chunks(size).collect() };
    let last = parts.len() - 1;
    parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let flags = u8::from(i == 0) | (u8::from(i == last) << 1);
            [&[flags][..], p].concat()
        })
        .collect()
}

/// Puts frames back together. Feed each notification; returns the message when its last frame arrives.
#[derive(Default)]
pub struct Reassembler {
    buf: Vec<u8>,
    started: bool,
}

impl Reassembler {
    pub fn push(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        let (&flags, data) = frame.split_first()?;
        if flags & 1 != 0 {
            self.buf.clear();
            self.started = true;
        }
        if !self.started {
            return None;
        }
        self.buf.extend_from_slice(data);
        if flags & 2 != 0 {
            self.started = false;
            return Some(std::mem::take(&mut self.buf));
        }
        None
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "cmd", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    /// What the sensor is connected to and doing.
    Status,
    /// Wi-Fi networks the sensor can see (for the app's network menu).
    Networks,
    /// Scan. With `ssid`, the sensor joins that Wi-Fi just for this scan, then leaves it and deletes the password.
    /// `range` defaults to the network it's on.
    Scan {
        range: Option<String>,
        #[serde(default)]
        quiet: bool,
        community: Option<String>,
        ssid: Option<String>,
        password: Option<String>,
    },
    /// Measure nearby Wi-Fi over and over until `cancel`, one "wifi" event per sweep (for a heatmap made while
    /// walking). `intervalMs` is the least time between readings; 0 = as fast as the adapter goes. Busy meanwhile.
    Survey {
        #[serde(default)]
        interval_ms: u32,
    },
    Cancel,
    /// Stop being this app's sensor: the next app to connect becomes the owner.
    Release,
}

/// INFO's plain (readable by anyone nearby) content.
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub v: u32,
    pub name: String,
    pub version: String,
    /// Stable id for this sensor (from /etc/machine-id): where the app files the owner secret.
    pub id: String,
    pub owned: bool,
    /// While not owned: the sensor's public key for a claim.
    pub claim_pub: Option<String>,
    pub nonce: String,
    pub busy: bool,
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_gives_both_sides_the_same_secret() {
        let (sensor_priv, sensor_pub) = keypair();
        let (app_priv, app_pub) = keypair();
        let bytes = claim_bytes(&app_pub);
        assert_eq!(as_claim(&bytes), Some(app_pub));
        assert_eq!(owner_secret(&sensor_priv, &as_claim(&bytes).unwrap()), owner_secret(&app_priv, &sensor_pub));
        // Someone else's key gives a different secret.
        let (other_priv, _) = keypair();
        assert_ne!(owner_secret(&other_priv, &sensor_pub), owner_secret(&app_priv, &sensor_pub));
        assert_eq!(as_claim(&[CLAIM; 20]), None);
    }

    #[test]
    fn commands_need_the_owner_and_the_current_nonce() {
        let owner = random::<32>();
        let n = random::<16>();
        let cmd = Command::Scan { range: None, quiet: true, community: None, ssid: Some("Example Clinic".into()), password: Some("not-a-real-one".into()) };
        let bytes = command_bytes(&owner, &n, &cmd);
        assert_eq!(read_command(&owner, &n, &bytes), Ok(cmd));
        assert_eq!(read_command(&random::<32>(), &n, &bytes), Err("not the owner"));
        assert_eq!(read_command(&owner, &random::<16>(), &bytes), Err("stale"));
        // The password isn't in the bytes in the clear, and a changed byte is refused.
        assert!(!bytes.windows(14).any(|w| w == b"not-a-real-one"));
        let mut tampered = bytes.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(read_command(&owner, &n, &tampered), Err("not the owner"));
        // A command is never mistaken for a claim.
        assert_eq!(as_claim(&bytes), None);
    }

    #[test]
    fn frames_round_trip() {
        let msg: Vec<u8> = (0..1000u32).map(|i| i as u8).collect();
        let f = frames(&msg, 182);
        assert!(f.iter().all(|x| x.len() <= 182));
        assert_eq!(f.len(), 6);
        let mut r = Reassembler::default();
        let out: Vec<Vec<u8>> = f.iter().filter_map(|x| r.push(x)).collect();
        assert_eq!(out, vec![msg]);
        let mut r = Reassembler::default();
        assert_eq!(r.push(&[2, b'z']), None);
        assert_eq!(frames(b"hi", 20), vec![vec![3, b'h', b'i']]);
        assert_eq!(r.push(&[3, b'h', b'i']), Some(b"hi".to_vec()));
    }

    #[test]
    fn survey_command_json() {
        let c: Command = serde_json::from_str(r#"{"cmd":"survey","intervalMs":1500}"#).unwrap();
        assert_eq!(c, Command::Survey { interval_ms: 1500 });
        assert_eq!(serde_json::from_str::<Command>(r#"{"cmd":"survey"}"#).unwrap(), Command::Survey { interval_ms: 0 });
        assert_eq!(serde_json::to_string(&Command::Survey { interval_ms: 0 }).unwrap(), r#"{"cmd":"survey","intervalMs":0}"#);
        // The older commands are unchanged.
        assert_eq!(serde_json::to_string(&Command::Cancel).unwrap(), r#"{"cmd":"cancel"}"#);
        let scan: Command = serde_json::from_str(r#"{"cmd":"scan","quiet":true}"#).unwrap();
        assert!(matches!(scan, Command::Scan { quiet: true, range: None, .. }));
    }

    #[test]
    fn events_seal_and_open() {
        let k = key(&random::<32>(), &random::<16>());
        let s = seal(&k, br#"{"type":"done"}"#);
        assert_eq!(open(&k, &s).unwrap(), br#"{"type":"done"}"#);
        assert!(open(&key(&random::<32>(), &random::<16>()), &s).is_none());
        assert_eq!(unhex::<2>("0aff"), Some([10, 255]));
    }
}
