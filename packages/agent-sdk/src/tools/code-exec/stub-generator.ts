// tools/code-exec/stub-generator.ts
import type { BridgeEndpoint, ExecLanguage } from '../../ports/execution-environment-port.js';

export const FN_NAME_BY_TOOL: Record<string, string> = {
  WebSearch: 'web_search', WebFetch: 'web_fetch', Read: 'read_file',
  Write: 'write_file', Grep: 'grep', Glob: 'glob', Bash: 'run', Edit: 'edit',
  Patch: 'patch',
};

/**
 * The idiomatic in-code fn names a given whitelist actually generates stubs for,
 * in whitelist order (tools with no mapping are dropped — same filter the stub
 * generator applies). The `execute_code` description derives its advertised
 * function list from THIS so it can never drift from the real generated stubs
 * (the original hand-written list silently omitted `edit`).
 */
export function fnNamesForWhitelist(whitelist: string[]): string[] {
  return whitelist.filter((t) => FN_NAME_BY_TOOL[t]).map((t) => FN_NAME_BY_TOOL[t]);
}

const PY_HEADER = (sock: string, token: string) => `# AUTO-GENERATED vestra tool stubs — do not edit
import json as _json, socket as _socket, threading as _t
_VESTRA_SOCK = ${JSON.stringify(sock)}
_VESTRA_TOKEN = ${JSON.stringify(token)}
_VESTRA_LOCK = _t.Lock()
class ToolError(Exception): pass
def _call(_tool, _args):
    with _VESTRA_LOCK:
        s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM); s.connect(_VESTRA_SOCK)
        try:
            s.sendall((_json.dumps({"token": _VESTRA_TOKEN, "tool": _tool, "args": _args}) + "\\n").encode())
            buf = b""
            while not buf.endswith(b"\\n"):
                chunk = s.recv(65536)
                if not chunk: break
                buf += chunk
        finally:
            s.close()
    r = _json.loads(buf.decode())
    if not r.get("ok"): raise ToolError(r.get("error") or "tool call failed")
    return r.get("text", "")
`;

const PY_FN = (fn: string, tool: string) => `def ${fn}(**kwargs):
    return _call(${JSON.stringify(tool)}, kwargs)
`;

// The snippet is written as a `.mjs` (ESM) file, so the header MUST use ESM
// imports — a top-level `require()` throws "require is not defined in ES module
// scope" and every language:'node' run dies before any tool call. The inline
// `_CLIENT` helper below stays CommonJS-shaped on purpose: it is evaluated via
// `node -e` (CommonJS by default), so its own `require('net')` is correct there.
const NODE_HEADER = (sock: string, token: string) => `// AUTO-GENERATED vestra tool stubs — do not edit
import { execFileSync as _execSync } from 'node:child_process';
const _SOCK = ${JSON.stringify(sock)};
const _TOKEN = ${JSON.stringify(token)};
class ToolError extends Error {}
// Synchronous UDS round-trip via a tiny python helper avoided: use a blocking socket through a worker.
function _call(tool, args) {
  const payload = JSON.stringify({ token: _TOKEN, tool, args }) + "\\n";
  const res = _execSync(process.execPath, ['-e', _CLIENT], { input: JSON.stringify({ sock: _SOCK, payload }), encoding: 'utf8' });
  const r = JSON.parse(res);
  if (!r.ok) throw new ToolError(r.error || 'tool call failed');
  return r.text || '';
}
const _CLIENT = \`const {StringDecoder}=require('string_decoder');const net=require('net');const di=new StringDecoder('utf8');let i='';process.stdin.on('data',d=>i+=di.write(d));process.stdin.on('end',()=>{i+=di.end();const{sock,payload}=JSON.parse(i);const c=net.createConnection(sock);const dr=new StringDecoder('utf8');let b='';c.on('connect',()=>c.write(payload));c.on('data',d=>{b+=dr.write(d);if(b.endsWith('\\\\n')){c.end();}});c.on('end',()=>{b+=dr.end();process.stdout.write(b.trim());});c.on('error',e=>{process.stdout.write(JSON.stringify({ok:false,error:String(e)}));});});\`;
`;

const NODE_FN = (fn: string, tool: string) => `function ${fn}(args = {}) { return _call(${JSON.stringify(tool)}, args); }
`;

export function generateStub(language: ExecLanguage, whitelist: string[], bridge: BridgeEndpoint): string {
  const fns = whitelist.filter((t) => FN_NAME_BY_TOOL[t]);
  if (language === 'python') {
    return PY_HEADER(bridge.address, bridge.token) + fns.map((t) => PY_FN(FN_NAME_BY_TOOL[t], t)).join('\n');
  }
  return NODE_HEADER(bridge.address, bridge.token) + fns.map((t) => NODE_FN(FN_NAME_BY_TOOL[t], t)).join('\n');
}
