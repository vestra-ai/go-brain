// The contract's TEST Ed25519 key pair, from packages/contract/test-vectors/spend-approval.json.
// TEST KEY ONLY. The simulator signs spend approvals with it in development and tests. The real Server
// signs with its own GO_SPEND_PRIVATE_KEY, which never appears in any repo.
export const TEST_SPEND_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n';
export const TEST_SPEND_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n';
