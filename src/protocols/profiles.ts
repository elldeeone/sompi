export const SUPPORTED_PROTOCOL_PROFILES = Object.freeze({
  ap2: Object.freeze({
    release: "v0.2.0",
    gitCommit: "b4587ac1d055888a73b4b21750973cffba961793",
    specification: "https://github.com/google-agentic-commerce/AP2/tree/v0.2.0/docs/ap2",
    profileId: "ap2-v0.2-hp-direct-sd-jwt-es256",
    mode: "human-present",
    checkoutMandateVct: "mandate.checkout.1",
    paymentMandateVct: "mandate.payment.1",
    digestAlgorithm: "sha-256",
    signatureAlgorithms: Object.freeze(["ES256"] as const),
    nativeKasProfile: "urn:sompi:ap2:payment-instrument:kaspa-x402:1",
    nativeKasStrictlyStandardized: false,
  }),
  x402: Object.freeze({
    version: 2,
    scheme: "exact",
    network: "kaspa:testnet-10",
    allowMainnet: false,
    packages: Object.freeze({
      core: Object.freeze({
        version: "0.1.0-alpha.6",
        integrity: "sha512-LKlqnX6p3mZSNRimUEr0J5p5odcgoYK2n2STHi6pfnUNhUejqXmFJJNYz0Vo9f2Utas4vLAGO1KcsioBUIFhMg==",
      }),
      covenant: Object.freeze({
        version: "0.1.0-alpha.6",
        integrity: "sha512-hZSmIMYD0AHGc+cROZ/OlAoHbooGcFmUYn3bvHWCMt1AK310mqKCVyCqWXd0dl2B4K6455UwGfAr1NHmgqWl8Q==",
      }),
      client: Object.freeze({
        version: "0.1.0-alpha.6",
        integrity: "sha512-BEyiCDh7tdMJxOmtlKj/8yxnqskF5SbxcbdcSeTkjHXVTmzm7rBkgQ69Q56DWEvaevtoGVolBrBjcN/Sm7TTdQ==",
      }),
      server: Object.freeze({
        version: "0.1.0-alpha.6",
        integrity: "sha512-Wi84DBsbvxgszJxgw5afjkEDGPR4kdN1CvY/n32YRFRSmDbPup8TGf3m2GyyK2V4FQWcdwP9FsS07kOLthLfkA==",
      }),
    }),
    npmGitCommit: "28ac222d3a375b9a2a56c11396f388086eeeae76",
  }),
  sqlite: Object.freeze({
    implementation: "better-sqlite3",
    version: "12.11.1",
    integrity: "sha512-dq9AtApgg5PGFtBzPFSBl3HZQjHok5gaQCM6zh2Yk0aSmDCs1CbnVI8/HgASQkNKsWFpseIO9beg5xxpYhbIfA==",
    typesVersion: "7.6.13",
  }),
  sdJwt: Object.freeze({
    implementation: "@sd-jwt/core",
    version: "0.20.0",
    npmGitCommit: "af170ace9b42984f8c6447caf23256fde6204b31",
    integrity: "sha512-thTj5xtKqOvqnULELJGvCa64Hf+Hf7v0Dlao6mTh198rmZcyFCBop3vT1ShgWMhg5cL04ofXeiEhnQR10/8wjA==",
  }),
  jose: Object.freeze({
    implementation: "jose",
    version: "5.10.0",
    npmGitCommit: "839b6dad41af850ced40c7a9badf1d725259aefc",
    integrity: "sha512-s+3Al/p9g32Iq+oqXxkW//7jk2Vig6FF1CFqzVXoTUXt2qz89YWbL+OwS17NFYEvxC35n0FKeGO2LGYSxeM2Gg==",
  }),
  jsonSchema: Object.freeze({
    ajvVersion: "8.20.0",
    ajvIntegrity: "sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==",
    formatsVersion: "3.0.1",
    formatsIntegrity: "sha512-8iUql50EUR+uUcdRQ3HDqa6EVyo3docL8g5WJ3FNcWmu62IbkGUue/pEyLBW8VGKKucTPgqeks4fIU1DA4yowQ==",
  }),
} as const);

export type SupportedProtocolProfiles = typeof SUPPORTED_PROTOCOL_PROFILES;
