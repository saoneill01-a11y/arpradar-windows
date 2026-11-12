//! Tools › ARPradar Sensor: the app's side of the sensor's Bluetooth LE link (same as the Mac's Sensor/SensorLink.swift).
//! The protocol and its crypto are the sensor's own sensor/src/link.rs, compiled in here, so both ends always agree.
//!
//! The window gets "sensor" events: {kind:"nearby", id, name, rssi}, {kind:"phase", phase, text}, {kind:"info", name,
//! version} and {kind:"event", ev} (a decrypted event from the sensor: status, networks, progress, devices, done, error,
//! released). Owner secrets are kept in sensor-owners.json next to data.json, by sensor id (not Credential Manager, to
//! match the Mac, which avoids the Keychain's prompts).

#[allow(dead_code)]
#[path = "../../sensor/src/link.rs"]
pub mod link;

use btleplug::api::{Central, CentralEvent, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral, PeripheralId};
use futures::StreamExt;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager as _;
use uuid::Uuid;

fn uuid(s: &str) -> Uuid {
    Uuid::parse_str(s).expect("a valid UUID")
}

#[derive(Default)]
struct Inner {
    adapter: Option<Adapter>,
    found: HashMap<String, PeripheralId>,
    selected: Option<String>,
    peripheral: Option<Peripheral>,
    chars: HashMap<Uuid, Characteristic>,
    sensor_id: String,
}

/// The link, kept by Tauri. `inner` is held across one command at a time (INFO read, claim, write), so each command
/// gets its own fresh nonce.
#[derive(Default)]
pub struct SensorState {
    inner: tokio::sync::Mutex<Inner>,
    /// The keys of the last two commands: events are sealed with the key of the command they answer.
    keys: std::sync::Mutex<Vec<link::Secret>>,
}

fn emit(app: &tauri::AppHandle, v: serde_json::Value) {
    let _ = app.emit("sensor", v);
}
fn phase(app: &tauri::AppHandle, phase: &str, text: &str) {
    emit(app, serde_json::json!({ "kind": "phase", "phase": phase, "text": text }));
}

// MARK: Owner secrets

fn owners_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("sensor-owners.json"))
}
fn owners(app: &tauri::AppHandle) -> HashMap<String, String> {
    owners_file(app).and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
fn save_owners(app: &tauri::AppHandle, m: &HashMap<String, String>) {
    if let Some(f) = owners_file(app) {
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        let _ = std::fs::write(f, serde_json::to_string(m).unwrap_or_default());
    }
}
fn owner_get(app: &tauri::AppHandle, id: &str) -> Option<link::Secret> {
    owners(app).get(id).and_then(|h| link::unhex::<32>(h))
}
fn owner_set(app: &tauri::AppHandle, id: &str, secret: &link::Secret) {
    let mut m = owners(app);
    m.insert(id.to_string(), link::hex(secret));
    save_owners(app, &m);
}
fn owner_delete(app: &tauri::AppHandle, id: &str) {
    let mut m = owners(app);
    m.remove(id);
    save_owners(app, &m);
}

// MARK: Looking for sensors

/// Starts Bluetooth and looks for sensors (they advertise the ARPradar Sensor service).
pub async fn start(app: tauri::AppHandle, state: &SensorState) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    if inner.adapter.is_some() {
        return Ok(());
    }
    let manager = Manager::new().await.map_err(|e| format!("Bluetooth isn\u{2019}t available on this PC ({e})."))?;
    let Some(adapter) = manager.adapters().await.map_err(|e| e.to_string())?.into_iter().next() else {
        phase(&app, "bluetoothOff", "This PC has no Bluetooth LE (or Bluetooth is turned off in Settings).");
        return Ok(());
    };
    let mut events = adapter.events().await.map_err(|e| e.to_string())?;
    if let Err(e) = adapter.start_scan(ScanFilter { services: vec![uuid(link::SERVICE)] }).await {
        phase(&app, "bluetoothOff", &format!("Bluetooth is off on this PC ({e}). Turn it on in Settings › Bluetooth & devices."));
        return Ok(());
    }
    inner.adapter = Some(adapter.clone());
    drop(inner);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = events.next().await {
            let (id, gone) = match ev {
                CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => (id, false),
                CentralEvent::DeviceDisconnected(id) => (id, true),
                _ => continue,
            };
            let key = format!("{id:?}");
            let state = app2.state::<SensorState>();
            if gone {
                let mut inner = state.inner.lock().await;
                if inner.selected.as_deref() == Some(&key) {
                    inner.selected = None;
                    inner.peripheral = None;
                    inner.chars.clear();
                    phase(&app2, "failed", "The sensor disconnected. Click it again to reconnect.");
                }
                continue;
            }
            let Ok(p) = adapter.peripheral(&id).await else { continue };
            let Ok(Some(props)) = p.properties().await else { continue };
            // Only ARPradar sensors (Windows can report other devices while scanning with a filter).
            if !props.services.contains(&uuid(link::SERVICE)) {
                continue;
            }
            let Some(rssi) = props.rssi.filter(|r| *r < 0) else { continue };
            state.inner.lock().await.found.insert(key.clone(), id.clone());
            emit(&app2, serde_json::json!({ "kind": "nearby", "id": key, "name": props.local_name.unwrap_or_else(|| "ARPradar Sensor".into()), "rssi": rssi }));
        }
    });
    Ok(())
}

// MARK: Connecting

pub async fn select(app: tauri::AppHandle, state: &SensorState, id: String) -> Result<(), String> {
    disconnect(state).await;
    let peripheral = {
        let mut inner = state.inner.lock().await;
        let (Some(adapter), Some(pid)) = (inner.adapter.clone(), inner.found.get(&id).cloned()) else { return Err("That sensor isn\u{2019}t nearby any more.".into()) };
        let p = adapter.peripheral(&pid).await.map_err(|e| e.to_string())?;
        inner.selected = Some(id.clone());
        inner.peripheral = Some(p.clone());
        p
    };
    phase(&app, "connecting", "");
    let ready = async {
        if !peripheral.is_connected().await.unwrap_or(false) {
            peripheral.connect().await.map_err(|e| format!("Couldn\u{2019}t connect to the sensor ({e})."))?;
        }
        // The sensor may still be starting up: look for its service a few times.
        for tries in 0.. {
            peripheral.discover_services().await.map_err(|e| e.to_string())?;
            if peripheral.services().iter().any(|s| s.uuid == uuid(link::SERVICE)) {
                break;
            }
            if tries >= 5 {
                return Err("That device isn\u{2019}t answering as an ARPradar Sensor.".to_string());
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
        let chars: HashMap<Uuid, Characteristic> = peripheral.characteristics().into_iter().map(|c| (c.uuid, c)).collect();
        let events = chars.get(&uuid(link::EVENTS)).cloned().ok_or("That isn\u{2019}t an ARPradar Sensor.")?;
        peripheral.subscribe(&events).await.map_err(|e| e.to_string())?;
        Ok::<_, String>(chars)
    };
    let chars = match tokio::time::timeout(Duration::from_secs(20), ready).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            disconnect(state).await;
            phase(&app, "failed", &e);
            return Ok(());
        }
        Err(_) => {
            disconnect(state).await;
            phase(&app, "failed", "Couldn\u{2019}t reach the sensor. Make sure it\u{2019}s on and nearby, then click it again.");
            return Ok(());
        }
    };
    state.inner.lock().await.chars = chars;
    // Events: frames put back together, opened with the key of the command they answer.
    let mut notes = peripheral.notifications().await.map_err(|e| e.to_string())?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut frames = link::Reassembler::default();
        while let Some(n) = notes.next().await {
            if n.uuid != uuid(link::EVENTS) {
                continue;
            }
            let Some(msg) = frames.push(&n.value) else { continue };
            let keys = app2.state::<SensorState>().keys.lock().unwrap().clone();
            let Some(plain) = keys.iter().rev().find_map(|k| link::open(k, &msg)) else { continue };
            if let Ok(ev) = serde_json::from_slice::<serde_json::Value>(&plain) {
                emit(&app2, serde_json::json!({ "kind": "event", "ev": ev }));
            }
        }
    });
    // Connected: claim it if it's free, then its status and the Wi-Fi networks it can see.
    send(app.clone(), state, serde_json::json!({ "cmd": "status" })).await?;
    send(app, state, serde_json::json!({ "cmd": "networks" })).await
}

pub async fn disconnect(state: &SensorState) {
    let mut inner = state.inner.lock().await;
    if let Some(p) = inner.peripheral.take() {
        let _ = p.disconnect().await;
    }
    inner.selected = None;
    inner.chars.clear();
    inner.sensor_id.clear();
    state.keys.lock().unwrap().clear();
}

// MARK: Commands

/// Sends one command: reads INFO for a fresh nonce, claims a free sensor first (this PC becomes its owner), then writes
/// the sealed command. A refused write gets one more try with a fresh nonce; refused again means another owner.
pub async fn send(app: tauri::AppHandle, state: &SensorState, cmd: serde_json::Value) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let (Some(p), Some(info_c), Some(cmd_c)) =
        (inner.peripheral.clone(), inner.chars.get(&uuid(link::INFO)).cloned(), inner.chars.get(&uuid(link::COMMAND)).cloned())
    else {
        return Err("Not connected to a sensor.".into());
    };
    let body = serde_json::to_vec(&cmd).map_err(|e| e.to_string())?;
    for attempt in 0..2 {
        let raw = p.read(&info_c).await.map_err(|e| format!("Couldn\u{2019}t read the sensor ({e})."))?;
        let info: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "The sensor answered with something unexpected.".to_string())?;
        let (Some(nonce), Some(id)) = (info["nonce"].as_str().and_then(link::unhex::<16>), info["id"].as_str()) else {
            return Err("The sensor answered with something unexpected.".into());
        };
        inner.sensor_id = id.to_string();
        emit(&app, serde_json::json!({ "kind": "info", "name": info["name"].as_str().unwrap_or("ARPradar Sensor"), "version": info["version"].as_str().unwrap_or("") }));
        let owned = info["owned"].as_bool().unwrap_or(true);
        if !owned {
            // A free sensor: this PC becomes its owner. Then INFO again for the nonce the command needs.
            let Some(their) = info["claimPub"].as_str().and_then(link::unhex::<32>) else { return Err("The sensor answered with something unexpected.".into()) };
            let (mine, public) = link::keypair();
            let secret = link::owner_secret(&mine, &their);
            if p.write(&cmd_c, &link::claim_bytes(&public), WriteType::WithResponse).await.is_err() {
                phase(&app, "failed", "Couldn\u{2019}t set this PC up as the sensor\u{2019}s owner. Click it again to retry.");
                return Ok(());
            }
            owner_set(&app, id, &secret);
            continue_with_claim(&app, state, &p, &info_c, &cmd_c, &secret, &body).await?;
            return Ok(());
        }
        let Some(secret) = owner_get(&app, id) else {
            phase(&app, "ownedByOther", "");
            return Ok(());
        };
        let key = link::key(&secret, &nonce);
        remember_key(state, key);
        let bytes = [nonce.as_slice(), &link::seal(&key, &body)].concat();
        match p.write(&cmd_c, &bytes, WriteType::WithResponse).await {
            Ok(()) => return Ok(()),
            Err(_) if attempt == 0 => continue, // most often an old nonce: one more try with a fresh one
            Err(_) => {
                // Still refused: this PC's key no longer fits (released or reset elsewhere).
                owner_delete(&app, id);
                phase(&app, "ownedByOther", "");
                return Ok(());
            }
        }
    }
    Ok(())
}

/// After a claim: the waiting command with a fresh nonce.
async fn continue_with_claim(app: &tauri::AppHandle, state: &SensorState, p: &Peripheral, info_c: &Characteristic, cmd_c: &Characteristic,
                             secret: &link::Secret, body: &[u8]) -> Result<(), String> {
    let raw = p.read(info_c).await.map_err(|e| e.to_string())?;
    let info: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "The sensor answered with something unexpected.".to_string())?;
    let nonce = info["nonce"].as_str().and_then(link::unhex::<16>).ok_or("The sensor answered with something unexpected.")?;
    let key = link::key(secret, &nonce);
    remember_key(state, key);
    let bytes = [nonce.as_slice(), &link::seal(&key, body)].concat();
    if p.write(cmd_c, &bytes, WriteType::WithResponse).await.is_err() {
        phase(app, "failed", "Couldn\u{2019}t set this PC up as the sensor\u{2019}s owner. Click it again to retry.");
    }
    Ok(())
}

fn remember_key(state: &SensorState, key: link::Secret) {
    let mut keys = state.keys.lock().unwrap();
    keys.push(key);
    let n = keys.len();
    if n > 2 {
        keys.drain(..n - 2);
    }
}

/// After "released": this PC forgets the owner key.
pub async fn forget_owner(app: tauri::AppHandle, state: &SensorState) {
    let id = state.inner.lock().await.sensor_id.clone();
    if !id.is_empty() {
        owner_delete(&app, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The app side builds commands the sensor side accepts, and opens what the sensor seals (the same code both ends).
    #[test]
    fn talks_the_sensors_protocol() {
        let (sensor_priv, sensor_pub) = link::keypair();
        let (app_priv, app_pub) = link::keypair();
        let owner_app = link::owner_secret(&app_priv, &sensor_pub);
        let owner_sensor = link::owner_secret(&sensor_priv, &link::as_claim(&link::claim_bytes(&app_pub)).unwrap());
        assert_eq!(owner_app, owner_sensor);
        let nonce = link::random::<16>();
        let body = serde_json::to_vec(&serde_json::json!({ "cmd": "scan", "quiet": true, "range": "10.20.30.0/24" })).unwrap();
        let key = link::key(&owner_app, &nonce);
        let bytes = [nonce.as_slice(), &link::seal(&key, &body)].concat();
        assert!(matches!(link::read_command(&owner_sensor, &nonce, &bytes), Ok(link::Command::Scan { quiet: true, .. })));
        let event = link::seal(&link::key(&owner_sensor, &nonce), br#"{"type":"done"}"#);
        let frames = link::frames(&event, 182);
        let mut r = link::Reassembler::default();
        let msg = frames.iter().find_map(|f| r.push(f)).unwrap();
        assert_eq!(link::open(&key, &msg).unwrap(), br#"{"type":"done"}"#);
        assert_eq!(uuid(link::SERVICE).to_string(), link::SERVICE);
    }
}
