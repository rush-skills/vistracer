# GeoIP fixtures

MaxMind DB test files for the tests in `src/commands/geo.rs`. They come
unchanged from the `test-data/` directory of
<https://github.com/maxmind/MaxMind-DB>, commit
`255b9a8b8a692d70dcaef31dc2ca44fa7ce50ece` (2026-10-22). The records are
MaxMind's test records, not a GeoLite2 release.

License: Apache-2.0 or MIT, at your option. Copyright (c) 2013 - 2026 by
MaxMind, Inc. This directory uses the MIT terms; the text is in
[LICENSE-MIT](./LICENSE-MIT).

| File | Size | SHA-256 | Used for |
| --- | --- | --- | --- |
| `GeoLite2-City-Test.mmdb` | 16,560 B | `8b6b4983c0d6c61d293f6da4a01f037c22b7c4457621e64289220dc86cd2506f` | City records: 81.2.69.142 (London, GB, 51.5142, -0.0931, radius 10 km), 2001:218::/32 (JP, no city, radius 100 km); no record for 1.1.1.1 |
| `GeoLite2-ASN-Test.mmdb` | 11,958 B | `a0f9e8614ad582ba1af3eeb18ead666f73ad6e4cbd5280f80d5d4d95bbe6c3f1` | ASN records: 1.128.0.0/11 (AS1221 Telstra Pty Ltd), 2600:6000::/20 (AS237 Merit Network Inc.); no record for 1.1.1.1 |
| `GeoIP2-City-Test-Broken-Double-Format.mmdb` | 22,478 B | `a340a6871b8bee8351befb8ad26f5229453705dddee0e948a35a65916c931e9c` | A damaged file: it opens, but its doubles have the wrong size, so records do not decode |
| `MaxMind-DB-test-decoder.mmdb` | 3,158 B | `e46b3f1945372922e465afa8a2ac110fe4e1f05248a61534aa36f8c54757e8cf` | One value of each MMDB data type (key = type name) at 1.1.1.0/24, for the `accuracy_radius` reader |

To update, download each file from
`https://raw.githubusercontent.com/maxmind/MaxMind-DB/<commit>/test-data/<file>`,
then update the commit, sizes and hashes here and run `cargo test commands::geo`.
