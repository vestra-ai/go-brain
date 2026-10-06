import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

type Cbor = Parameters<typeof isoCBOR.encode>[0];
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/**
 * A software passkey: what Face ID does on the phone, built from node:crypto (ES256, attestation none).
 * Its responses go through @simplewebauthn/server's real checks.
 */
export class TestAuthenticator {
  readonly credentialId: Buffer = randomBytes(16);
  counter = 0;
  /** Face ID passed. A test sets it to false to play an authenticator that skipped user verification. */
  userVerified: boolean;
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;

  constructor(
    readonly rpId: string,
    readonly origin: string,
    opts: { userVerified?: boolean } = {},
  ) {
    this.userVerified = opts.userVerified ?? true;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(String(jwk.x), 'base64url');
    this.y = Buffer.from(String(jwk.y), 'base64url');
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  register(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const cose = new Map<string | number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      this.rpIdHash(),
      Buffer.from([this.flags() | 0x40]),
      this.counterBytes(),
      Buffer.alloc(16),
      idLength,
      this.credentialId,
      Buffer.from(isoCBOR.encode(cose)),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string | number, Cbor>([['fmt', 'none'], ['attStmt', new Map<string | number, Cbor>()], ['authData', authData]]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }

  assert(options: PublicKeyCredentialRequestOptionsJSON, o: { counter?: number } = {}): AuthenticationResponseJSON {
    this.counter = o.counter ?? this.counter + 1;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([this.flags()]), this.counterBytes()]);
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }

  /** User present always; user verified unless the test says otherwise. */
  private flags(): number {
    return 0x01 | (this.userVerified ? 0x04 : 0);
  }

  private rpIdHash(): Buffer {
    return createHash('sha256').update(this.rpId).digest();
  }

  private counterBytes(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(this.counter);
    return b;
  }
}
