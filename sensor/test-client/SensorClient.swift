// A small Mac test client for the ARPradar sensor's Bluetooth protocol (sensor/src/link.rs), and the first draft of
// the Mac app's own sensor code. Build and run:
//   swiftc -O sensor/test-client/SensorClient.swift -o /tmp/sensorclient
//   /tmp/sensorclient CODE status | scan [--quiet] [RANGE] | wifi SSID PASSWORD | forget
// The setup code is on the sensor's label (or: sudo arpradar-sensor code on the Pi).

import CoreBluetooth
import CryptoKit
import Foundation

enum SensorUUID {
    static let service = CBUUID(string: "41525052-4144-4152-0000-000000000001")
    static let info = CBUUID(string: "41525052-4144-4152-0000-000000000002")
    static let command = CBUUID(string: "41525052-4144-4152-0000-000000000003")
    static let events = CBUUID(string: "41525052-4144-4152-0000-000000000004")
}

/// The same crypto and framing as link.rs.
enum SensorCrypto {
    static func normalize(_ code: String) -> String {
        String(code.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII }).uppercased()
    }
    static func key(code: String, nonce: Data) -> SymmetricKey {
        var msg = Data("arpradar-sensor-v1".utf8); msg.append(nonce)
        let mac = HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: Data(normalize(code).utf8)))
        return SymmetricKey(data: Data(mac))
    }
    static func seal(_ plain: Data, key: SymmetricKey) throws -> Data {
        try AES.GCM.seal(plain, using: key).combined!   // iv(12) ‖ ciphertext ‖ tag(16)
    }
    static func open(_ sealed: Data, key: SymmetricKey) -> Data? {
        guard let box = try? AES.GCM.SealedBox(combined: sealed) else { return nil }
        return try? AES.GCM.open(box, using: key)
    }
    static func unhex(_ s: String) -> Data? {
        guard s.count % 2 == 0 else { return nil }
        var d = Data(); var i = s.startIndex
        while i < s.endIndex { let j = s.index(i, offsetBy: 2); guard let b = UInt8(s[i..<j], radix: 16) else { return nil }; d.append(b); i = j }
        return d
    }
}

/// Puts notification frames back together ([flags][bytes]; bit 0 first, bit 1 last).
struct Reassembler {
    private var buf = Data(), started = false
    mutating func push(_ frame: Data) -> Data? {
        guard let flags = frame.first else { return nil }
        if flags & 1 != 0 { buf = Data(); started = true }
        guard started else { return nil }
        buf.append(frame.dropFirst())
        if flags & 2 != 0 { started = false; defer { buf = Data() }; return buf }
        return nil
    }
}

final class Client: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    let code: String, command: [String: Any]
    var central: CBCentralManager!
    var peripheral: CBPeripheral?
    var chars: [CBUUID: CBCharacteristic] = [:]
    var key: SymmetricKey?
    var frames = Reassembler()
    var started = Date()

    init(code: String, command: [String: Any]) {
        self.code = code; self.command = command
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    func say(_ s: String) { FileHandle.standardError.write(Data("[\(String(format: "%5.1f", Date().timeIntervalSince(started))) s] \(s)\n".utf8)) }
    func quit(_ code: Int32) -> Never { if let p = peripheral { central.cancelPeripheralConnection(p) }; exit(code) }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn: say("Looking for ARPradar Sensor…"); c.scanForPeripherals(withServices: [SensorUUID.service])
        case .unauthorized: say("Bluetooth permission was refused (System Settings › Privacy & Security › Bluetooth)."); quit(1)
        case .poweredOff: say("Bluetooth is off on this Mac."); quit(1)
        default: break
        }
    }
    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        say("Found \(advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? p.name ?? "sensor") (signal \(rssi) dBm); connecting")
        c.stopScan(); peripheral = p; p.delegate = self; c.connect(p)
    }
    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) { p.discoverServices([SensorUUID.service]) }
    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) { say("Couldn’t connect: \(error?.localizedDescription ?? "?")"); quit(1) }
    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) { say("Disconnected"); quit(1) }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let s = p.services?.first(where: { $0.uuid == SensorUUID.service }) else { say("No ARPradar service"); quit(1) }
        p.discoverCharacteristics([SensorUUID.info, SensorUUID.command, SensorUUID.events], for: s)
    }
    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        for c in s.characteristics ?? [] { chars[c.uuid] = c }
        guard let ev = chars[SensorUUID.events], chars[SensorUUID.info] != nil, chars[SensorUUID.command] != nil else { say("Missing characteristics"); quit(1) }
        say("Connected (max write \(p.maximumWriteValueLength(for: .withResponse)) bytes)")
        p.setNotifyValue(true, for: ev)
    }
    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
        if let error { say("Subscribe failed: \(error.localizedDescription)"); quit(1) }
        p.readValue(for: chars[SensorUUID.info]!)   // the nonce for the command
    }
    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        guard let data = c.value else { return }
        if c.uuid == SensorUUID.info {
            guard let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let nonce = (info["nonce"] as? String).flatMap(SensorCrypto.unhex), nonce.count == 16 else { say("Bad INFO"); quit(1) }
            say("Sensor \(info["name"] ?? "?") \(info["version"] ?? "?"), busy: \(info["busy"] ?? "?")")
            let k = SensorCrypto.key(code: code, nonce: nonce)
            key = k
            let body = try! JSONSerialization.data(withJSONObject: command)
            var bytes = nonce; bytes.append(try! SensorCrypto.seal(body, key: k))
            say("Sending \(command["cmd"] ?? "?") (\(bytes.count) bytes, encrypted)")
            p.writeValue(bytes, for: chars[SensorUUID.command]!, type: .withResponse)
        } else if c.uuid == SensorUUID.events {
            guard let msg = frames.push(data) else { return }
            guard let key, let plain = SensorCrypto.open(msg, key: key),
                  let ev = try? JSONSerialization.jsonObject(with: plain) as? [String: Any] else { say("Couldn’t read an event"); return }
            show(ev, size: msg.count)
        }
    }
    func peripheral(_ p: CBPeripheral, didWriteValueFor c: CBCharacteristic, error: Error?) {
        if let error { say("Command refused: \(error.localizedDescription) (wrong setup code?)"); quit(2) }
        say("Command accepted")
    }

    func show(_ ev: [String: Any], size: Int) {
        switch ev["type"] as? String {
        case "progress": say("\(Int(((ev["fraction"] as? Double) ?? 0) * 100))% \(ev["text"] ?? "")")
        case "devices":
            let list = ev["devices"] as? [[String: Any]] ?? []
            say("Results: \(list.count) devices in \(ev["seconds"] ?? "?") s (\(size) bytes over Bluetooth)")
            for d in list.prefix(8) {
                print(String(format: "%-15@ %-17@ %-24@ %@", d["ip"] as? String ?? "", d["mac"] as? String ?? "", String((d["vendor"] as? String ?? "").prefix(24)), d["name"] as? String ?? ""))
            }
            if list.count > 8 { print("… and \(list.count - 8) more") }
        case "done": say("Done"); quit(0)
        case "error": say("Sensor error: \(ev["text"] ?? "")"); quit(1)
        default:
            say("\(ev)")
            if ["status", "wifi", "forgot"].contains(ev["type"] as? String ?? "") { quit(0) }
        }
    }
}

var args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: sensorclient CODE status | scan [--quiet] [RANGE] | wifi SSID PASSWORD | forget\n".utf8)); exit(2)
}
let code = args.removeFirst(), verb = args.removeFirst()
var cmd: [String: Any] = ["cmd": verb]
if verb == "scan" { cmd["quiet"] = args.contains("--quiet"); if let r = args.first(where: { !$0.hasPrefix("--") }) { cmd["range"] = r } }
if verb == "wifi" { guard args.count == 2 else { exit(2) }; cmd["ssid"] = args[0]; cmd["password"] = args[1] }
let client = Client(code: code, command: cmd)
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { client.say("Timed out"); client.quit(1) }
RunLoop.main.run()
