//! The sensor's Bluetooth protocol, shared by the Pi (server) and the apps (clients). Plain Rust, so it's tested on
//! any computer; the Bluetooth plumbing itself is in ble.rs (Linux only).
//!
//! One GATT service with three characteristics:
//!   INFO     read    {"v":1,"name":…,"version":…,"nonce":hex,"busy":bool}   (nothing secret)
//!   COMMAND  write   nonce(16) ‖ iv(12) ‖ AES-256-GCM(key, iv, command JSON)
//!   EVENTS   notify  frames of: iv(12) ‖ AES-256-GCM(key, iv, event JSON)
//!
//! key = HMAC-SHA256(setup code, "arpradar-sensor-v1" ‖ nonce). The setup code is printed on the sensor's label;
//! without it a phone can't send commands (the GCM tag fails) or read anything sent back. The nonce in INFO changes
//! after every accepted command, so a recorded command can't be replayed. Events use the key of the last command.
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

/// Letters and digits that can't be mixed up when read off a label (no 0/O, 1/I/L).
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// A new setup code, "XXXX-XXXX-XXXX" (12 characters, about 59 bits).
pub fn new_setup_code() -> String {
    let mut raw = [0u8; 12];
    getrandom::getrandom(&mut raw).expect("random numbers");
    let chars: String = raw.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
    format!("{}-{}-{}", &chars[0..4], &chars[4..8], &chars[8..12])
}

/// "abcd-efgh 2345" → "ABCDEFGH2345": what goes into the key (dashes, spaces and case don't matter).
pub fn normalize_code(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

pub fn new_nonce() -> [u8; 16] {
    let mut n = [0u8; 16];
    getrandom::getrandom(&mut n).expect("random numbers");
    n
}

pub fn key(code: &str, nonce: &[u8; 16]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(normalize_code(code).as_bytes()).expect("any key length");
    m.update(b"arpradar-sensor-v1");
    m.update(nonce);
    m.finalize().into_bytes().into()
}

/// iv ‖ ciphertext (with tag).
pub fn seal(key: &[u8; 32], plain: &[u8]) -> Vec<u8> {
    let mut iv = [0u8; 12];
    getrandom::getrandom(&mut iv).expect("random numbers");
    let ct = Aes256Gcm::new(key.into()).encrypt(Nonce::from_slice(&iv), plain).expect("encrypt");
    [iv.as_slice(), &ct].concat()
}

/// None when the key is wrong (wrong setup code or old nonce) or the bytes were changed.
pub fn open(key: &[u8; 32], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < 12 + 16 {
        return None;
    }
    Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(&sealed[..12]), &sealed[12..]).ok()
}

/// A command as written to COMMAND: nonce ‖ sealed JSON.
pub fn command_bytes(code: &str, nonce: &[u8; 16], cmd: &Command) -> Vec<u8> {
    let json = serde_json::to_vec(cmd).expect("json");
    [nonce.as_slice(), &seal(&key(code, nonce), &json)].concat()
}

/// The Pi's side: the command, if it was made with this setup code and the current nonce.
pub fn read_command(code: &str, current_nonce: &[u8; 16], bytes: &[u8]) -> Result<Command, &'static str> {
    if bytes.len() < 16 || bytes[..16] != current_nonce[..] {
        return Err("stale");
    }
    let plain = open(&key(code, current_nonce), &bytes[16..]).ok_or("bad code")?;
    serde_json::from_slice(&plain).map_err(|_| "bad command")
}

/// Splits one message into notification-sized frames (`max` bytes each, flag byte included).
pub fn frames(message: &[u8], max: usize) -> Vec<Vec<u8>> {
    let size = max.max(8) - 1;
    let parts: Vec<&[u8]> = if message.is_empty() { vec![&[][..]] } else { message.chunks(size).collect() };
    let last = parts.len() - 1;
    parts.iter().enumerate().map(|(i, p)| {
        let flags = u8::from(i == 0) | (u8::from(i == last) << 1);
        [&[flags][..], p].concat()
    }).collect()
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
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum Command {
    /// What the sensor is connected to and doing.
    Status,
    /// Join a Wi-Fi network (the password only ever travels encrypted).
    Wifi { ssid: String, password: String },
    /// Scan a range (default: the network it's on).
    Scan { range: Option<String>, #[serde(default)] quiet: bool, community: Option<String> },
    Cancel,
    /// Forget every Wi-Fi network the sensor was given over Bluetooth.
    Forget,
}

/// INFO's plain (readable by anyone nearby) content.
#[derive(Serialize, Deserialize, Debug)]
pub struct Info {
    pub v: u32,
    pub name: String,
    pub version: String,
    pub nonce: String,
    pub busy: bool,
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex16(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes() {
        let c = new_setup_code();
        assert_eq!(c.len(), 14);
        assert!(normalize_code(&c).bytes().all(|b| ALPHABET.contains(&b)));
        assert_eq!(normalize_code("abcd-efgh 2345"), "ABCDEFGH2345");
        assert_ne!(new_setup_code(), new_setup_code());
    }

    #[test]
    fn commands_need_the_code_and_the_current_nonce() {
        let code = "ABCD-EFGH-2345";
        let n = new_nonce();
        let cmd = Command::Wifi { ssid: "Example Clinic".into(), password: "not-a-real-one".into() };
        let bytes = command_bytes(code, &n, &cmd);
        assert_eq!(read_command("abcd efgh 2345", &n, &bytes), Ok(cmd));
        assert_eq!(read_command("ABCD-EFGH-2346", &n, &bytes), Err("bad code"));
        assert_eq!(read_command(code, &new_nonce(), &bytes), Err("stale"));
        // The password isn't in the bytes in the clear.
        assert!(!bytes.windows(14).any(|w| w == b"not-a-real-one"));
        let mut tampered = bytes.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(read_command(code, &n, &tampered), Err("bad code"));
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
        // A small message is one frame; a frame arriving mid-message without a start is ignored.
        let mut r = Reassembler::default();
        assert_eq!(r.push(&[2, b'z']), None);
        assert_eq!(frames(b"hi", 20), vec![vec![3, b'h', b'i']]);
        assert_eq!(r.push(&[3, b'h', b'i']), Some(b"hi".to_vec()));
    }

    #[test]
    fn events_seal_and_open() {
        let k = key("ABCD-EFGH-2345", &new_nonce());
        let s = seal(&k, br#"{"type":"done"}"#);
        assert_eq!(open(&k, &s).unwrap(), br#"{"type":"done"}"#);
        assert!(open(&key("ZZZZ-EFGH-2345", &new_nonce()), &s).is_none());
    }
}
