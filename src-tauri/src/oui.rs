//! Manufacturer from the first half of a MAC address, using the IEEE list (resources/oui.csv,
//! the same file as the Mac app). Built into the program; read once, the first time it's needed.

use std::collections::HashMap;
use std::sync::OnceLock;

static TABLE: OnceLock<HashMap<String, String>> = OnceLock::new();

fn table() -> &'static HashMap<String, String> {
    TABLE.get_or_init(|| parse(include_str!("../resources/oui.csv")))
}

pub fn vendor(mac: &str) -> String {
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_uppercase();
    if hex.len() < 6 {
        return String::new();
    }
    // Second-lowest bit of the first byte = "locally administered" (phones' private Wi-Fi addresses).
    if let Ok(first) = u8::from_str_radix(&hex[0..2], 16) {
        if first & 0x02 != 0 {
            return "Private address".into();
        }
    }
    table().get(&hex[0..6]).cloned().unwrap_or_default()
}

fn parse(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines().skip(1) {
        let f = csv_fields(line.trim_end_matches('\r'));
        if f.len() >= 3 && f[1].len() == 6 {
            out.insert(f[1].to_uppercase(), f[2].trim().to_string());
        }
    }
    out
}

/// Minimal CSV splitter that understands "quoted, fields".
pub fn csv_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    fields.push(cur);
    fields
}

#[cfg(test)]
mod tests {
    #[test]
    fn lookup() {
        assert_eq!(super::vendor("28:6F:B9:00:00:01"), "Nokia Shanghai Bell Co., Ltd.");
        assert_eq!(super::vendor("02:00:00:00:00:01"), "Private address");
        assert_eq!(super::vendor(""), "");
    }
}
