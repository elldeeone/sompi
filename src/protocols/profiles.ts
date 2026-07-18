export const SUPPORTED_PROTOCOL_PROFILES = Object.freeze({
  ap2: Object.freeze({
    release: "v0.2.0",
    gitCommit: "b4587ac1d055888a73b4b21750973cffba961793",
    specification: "https://github.com/google-agentic-commerce/AP2/tree/v0.2.0/docs/ap2",
    mode: "human-present",
    evidenceProfile: "urn:sompi:ap2-derived-human-present:1",
    signatureAlgorithms: Object.freeze(["ES256"] as const),
    interoperability: "none",
    sourceWatchOnly: true,
  }),
  x402: Object.freeze({
    version: 2,
    scheme: "exact",
    network: "kaspa:testnet-10",
    allowMainnet: false,
    packages: Object.freeze({
      core: Object.freeze({
        version: "0.1.0-alpha.8",
        integrity: "sha512-UBY4g9jBZrJyd44zbsla01L2wbN+UQeButAiuEeFUd4EdGwVyR2qxMf1B4hApXBSvrOeH9UZQzhWkBD+Z3WT4A==",
      }),
      covenant: Object.freeze({
        version: "0.1.0-alpha.8",
        integrity: "sha512-HWySEyuNpzFDH4vVZRsUCnMLWWt2ou3sp1XEU+gaycl3O/7fWJPzWo1MYosZzPkS2newL6lXQSr/OR/YQ4wSag==",
      }),
      client: Object.freeze({
        version: "0.1.0-alpha.8",
        integrity: "sha512-n36rG2nYDrN7Dgu5jlh16390k/Z5sOnsj40a347ir8C9U/X/tlgPY24KB0YmUqVmxEOBYRAw2pAEKI/qDqIEwA==",
      }),
      server: Object.freeze({
        version: "0.1.0-alpha.8",
        integrity: "sha512-X5ax8oWGfJlxQqh2RaEQYHw0wQKbRR/iFoeJ9/2w93oNsOC++svNEA/MHlR4SSAiukdXI6PizcsYq0KwPi6jsA==",
      }),
    }),
    npmGitCommit: "d3ef63ebfb72ef5139993e75804fcc846a1f9487",
  }),
  sqlite: Object.freeze({
    implementation: "better-sqlite3",
    version: "12.11.1",
    integrity: "sha512-dq9AtApgg5PGFtBzPFSBl3HZQjHok5gaQCM6zh2Yk0aSmDCs1CbnVI8/HgASQkNKsWFpseIO9beg5xxpYhbIfA==",
    typesVersion: "7.6.13",
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
