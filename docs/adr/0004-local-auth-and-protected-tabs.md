# ADR 0004: Secure the local boundary and sensitive tabs

Status: accepted

Loopback is necessary but insufficient because local malware and DNS rebinding can reach localhost services. The gateway requires a bearer token, validates Host/Origin, and refuses non-loopback bindings/CDP URLs.

Sensitive URL patterns are denied for mutation unless the asserted agent ID is allowlisted. This MVP assumes authenticated clients honestly assert agent IDs; signed identity is required before expanding the trust boundary.
