//! Turns what's typed in the IP range box into addresses. Same rules as the Mac app:
//!   192.168.1.5             one address
//!   192.168.1.1-254         last-octet range
//!   192.168.1.1-192.168.2.10  full range
//!   10.0.0.0/24             subnet (network and broadcast skipped)
//! separated by commas, spaces or semicolons.

use std::net::Ipv4Addr;

pub const MAX_HOSTS: usize = 65_536;

pub fn ip(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.trim().split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut v: u32 = 0;
    for p in parts {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n: u32 = p.parse().ok()?;
        if n > 255 {
            return None;
        }
        v = (v << 8) | n;
    }
    Some(v)
}

pub fn text(v: u32) -> String {
    Ipv4Addr::from(v).to_string()
}

fn bounds(token: &str) -> Result<(u32, u32), String> {
    let bad = || format!("\u{201c}{token}\u{201d} isn\u{2019}t a valid IP, range or subnet.");
    if let Some((base, bits)) = token.split_once('/') {
        let base = ip(base).ok_or_else(bad)?;
        let bits: u32 = bits.parse().map_err(|_| bad())?;
        if bits > 32 {
            return Err(bad());
        }
        let mask: u32 = if bits == 0 { 0 } else { !0u32 << (32 - bits) };
        let net = base & mask;
        let bc = net | !mask;
        return Ok(if bits >= 31 { (net, bc) } else { (net + 1, bc - 1) });
    }
    if let Some((left, right)) = token.split_once('-') {
        let start = ip(left).ok_or_else(bad)?;
        let end = if let Some(full) = ip(right) {
            full
        } else {
            let last: u32 = right.trim().parse().map_err(|_| bad())?;
            if last > 255 {
                return Err(bad());
            }
            (start & 0xFFFF_FF00) | last
        };
        if end < start {
            return Err(bad());
        }
        return Ok((start, end));
    }
    let one = ip(token).ok_or_else(bad)?;
    Ok((one, one))
}

/// The address spans in the text, e.g. "10.0.0.1-5, 10.0.1.0/24" -> [(10.0.0.1, 10.0.0.5), (10.0.1.1, 10.0.1.254)].
pub fn spans(input: &str) -> Result<Vec<(u32, u32)>, String> {
    let tokens: Vec<&str> = input
        .split(|c: char| c == ',' || c == ' ' || c == ';' || c == '\n')
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Err("Enter an IP range to scan, like 192.168.1.1-254.".into());
    }
    let mut out = Vec::new();
    let mut total: u64 = 0;
    for t in tokens {
        let (lo, hi) = bounds(t)?;
        total += (hi - lo) as u64 + 1;
        if total > MAX_HOSTS as u64 {
            return Err(format!("That\u{2019}s more than {MAX_HOSTS} addresses. Try a smaller range."));
        }
        out.push((lo, hi));
    }
    Ok(out)
}

/// Every address in the text, in order, without repeats.
pub fn parse(input: &str) -> Result<Vec<u32>, String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (lo, hi) in spans(input)? {
        for v in lo..=hi {
            if seen.insert(v) {
                out.push(v);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse("192.168.1.1-3").unwrap().len(), 3);
        assert_eq!(parse("10.0.0.0/24").unwrap().len(), 254);
        assert_eq!(parse("10.0.0.5").unwrap(), vec![ip("10.0.0.5").unwrap()]);
        assert_eq!(parse("10.0.0.1-10.0.1.1").unwrap().len(), 257);
        assert_eq!(parse("10.0.0.1-3, 10.0.0.2").unwrap().len(), 3);
        assert!(parse("10.0.0.300").is_err());
        assert!(parse("").is_err());
        assert!(parse("10.0.0.0/8").is_err());
        assert!(parse("10.0.0.9-3").is_err());
    }
}
