// Site survey scans the organization's network, not whatever network this PC happens to be on.
const test = require("node:test");
const assert = require("node:assert");
const { SurveyRange } = require("../ui/surveyrange.js");
const home = "192.168.1.0/24", s = SurveyRange.suggested;
test("nothing known uses this network", () => assert.equal(s(home, "", ""), home));
test("on site keeps this network", () => assert.equal(s("10.20.30.0/22", "10.20.31.100-199", ""), "10.20.30.0/22"));
test("subnet DHCP range is used", () => assert.equal(s(home, "10.10.20.0/24", "10.10.20.11"), "10.10.20.0/24"));
test("start-end DHCP range gives its /24", () => assert.equal(s(home, "10.0.0.100-10.0.0.199", ""), "10.0.0.0/24"));
test("name server when no DHCP range", () => assert.equal(s(home, "", "172.16.8.20"), "172.16.8.0/24"));
test("bad input falls back to this network", () => assert.equal(s(home, "nope", "dc01"), home));
