/** Exercises the real src/lib/bridge.ts against mocked hosts. */
const BRIDGE = new URL('../src/lib/bridge.ts', import.meta.url).href;

let pass = 0, fail = 0;
const ok = (cond: boolean, label: string, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
};

type Sent = { target: string; message: string; origin?: string };

function setupWindow(opts: { rn?: boolean; framed?: boolean; popup?: boolean; referrer?: string }) {
  const sent: Sent[] = [];
  // window and document need SEPARATE buckets: a `message` event dispatched on
  // window does not also fire document listeners in a real browser.
  const winListeners: Record<string, Function[]> = {};
  const docListeners: Record<string, Function[]> = {};
  const self: any = {
    location: { origin: 'https://kyc.example.com' },
    addEventListener: (t: string, fn: Function) => { (winListeners[t] ??= []).push(fn); },
    removeEventListener: () => {},
  };
  self.parent = opts.framed ? { postMessage: (m: string, o: string) => sent.push({ target: 'parent', message: m, origin: o }) } : self;
  if (opts.rn) self.ReactNativeWebView = { postMessage: (m: string) => sent.push({ target: 'rn', message: m }) };
  if (opts.popup) self.opener = { postMessage: (m: string, o: string) => sent.push({ target: 'opener', message: m, origin: o }) };
  self.close = () => sent.push({ target: 'self.close', message: '' });

  (globalThis as any).window = self;
  (globalThis as any).document = {
    referrer: opts.referrer ?? '',
    addEventListener: (t: string, fn: Function) => { (docListeners[t] ??= []).push(fn); },
    removeEventListener: () => {},
  };
  return { sent, winListeners, docListeners, self };
}

const READY = { type: 'ready', payload: { sdkVersion: '2.12.0', transports: [] } } as any;

console.log('\ntransport detection & delivery');
{
  const { sent } = setupWindow({ rn: true });
  const b = await import(BRIDGE + '?1');
  b.configureBridge({});
  ok(JSON.stringify(b.detectTransports()) === '["react-native"]', 'RN WebView → ["react-native"]', JSON.stringify(b.detectTransports()));
  b.postToHost(READY);
  ok(sent.length === 1 && sent[0].target === 'rn', 'delivers via ReactNativeWebView');
}
{
  const { sent } = setupWindow({ framed: true });
  const b = await import(BRIDGE + '?2');
  b.configureBridge({ hostOrigin: 'https://app.example.com' });
  ok(JSON.stringify(b.detectTransports()) === '["iframe"]', 'iframe → ["iframe"]');
  b.postToHost(READY);
  ok(sent[0]?.target === 'parent' && sent[0].origin === 'https://app.example.com', 'parent gets pinned targetOrigin', JSON.stringify(sent[0]));
}
{
  const { sent } = setupWindow({ popup: true });
  const b = await import(BRIDGE + '?3');
  b.configureBridge({ hostOrigin: 'https://app.example.com' });
  ok(JSON.stringify(b.detectTransports()) === '["popup"]', 'window.opener → ["popup"]');
  b.postToHost(READY);
  ok(sent[0]?.target === 'opener' && sent[0].origin === 'https://app.example.com', 'opener gets pinned targetOrigin', JSON.stringify(sent[0]));
  ok(b.closeSelfIfPopup() === true, 'closeSelfIfPopup() closes a popup');
}
{
  const { sent } = setupWindow({ framed: true, popup: true });
  const b = await import(BRIDGE + '?4');
  b.configureBridge({ hostOrigin: 'https://app.example.com' });
  b.postToHost(READY);
  ok(sent.length === 2, 'framed AND opened → delivered to both', JSON.stringify(sent.map(s => s.target)));
  ok(b.closeSelfIfPopup() === false, 'does NOT self-close when framed');
}
{
  setupWindow({});
  const b = await import(BRIDGE + '?5');
  ok(JSON.stringify(b.detectTransports()) === '["standalone"]', 'no host → ["standalone"]');
}

console.log('\ntargetOrigin resolution');
{
  setupWindow({ framed: true, referrer: 'https://app.example.com/checkout?x=1' });
  const b = await import(BRIDGE + '?6');
  ok(b.configureBridge({}) === 'https://app.example.com', 'infers origin from document.referrer', b.configureBridge({}));
}
{
  setupWindow({ framed: true, referrer: 'https://app.example.com/x' });
  const b = await import(BRIDGE + '?7');
  ok(b.configureBridge({ hostOrigin: 'https://pinned.example.com' }) === 'https://pinned.example.com', 'explicit hostOrigin beats referrer');
}
{
  setupWindow({ framed: true });
  const b = await import(BRIDGE + '?8');
  ok(b.configureBridge({}) === '*', 'no hostOrigin and no referrer → "*"');
}

console.log('\ninbound command trust');
const fire = (bucket: any, ev: any) => [...(bucket.message ?? [])].forEach((fn: any) => fn(ev));
{
  const { winListeners, docListeners, self } = setupWindow({ framed: true });
  const b = await import(BRIDGE + '?9');
  b.configureBridge({ hostOrigin: 'https://app.example.com' });
  const got: any[] = [];
  b.onHostCommand((c: any) => got.push(c));

  fire(winListeners, { data: JSON.stringify({ type: 'close' }), origin: 'https://app.example.com', source: self.parent });
  ok(got.length === 1, 'accepts command from the pinned origin', 'got=' + got.length);

  fire(winListeners, { data: JSON.stringify({ type: 'close' }), origin: 'https://evil.example.com', source: {} });
  ok(got.length === 1, 'REJECTS command from another origin', 'got=' + got.length);

  fire(winListeners, { data: JSON.stringify({ type: 'close' }), origin: 'https://kyc.example.com', source: self });
  ok(got.length === 2, 'accepts same-origin (RN iOS injection)', 'got=' + got.length);

  // Android RN delivers on `document` with no origin.
  fire(docListeners, { data: JSON.stringify({ type: 'close' }), origin: undefined, source: self });
  ok(got.length === 3, 'accepts origin-less document event (RN Android)', 'got=' + got.length);

  fire(winListeners, { data: 'not json', origin: 'https://app.example.com', source: self.parent });
  ok(got.length === 3, 'ignores non-JSON noise on the channel', 'got=' + got.length);
}
{
  const { winListeners, self } = setupWindow({ framed: true });
  const b = await import(BRIDGE + '?10');
  b.configureBridge({}); // wildcard
  const got: any[] = [];
  b.onHostCommand((c: any) => got.push(c));
  fire(winListeners, { data: JSON.stringify({ type: 'close' }), origin: 'https://evil.example.com', source: {} });
  ok(got.length === 0, 'wildcard still rejects a non-parent/opener sender', 'got=' + got.length);
  fire(winListeners, { data: JSON.stringify({ type: 'close' }), origin: 'https://any.example.com', source: self.parent });
  ok(got.length === 1, 'wildcard accepts the actual parent', 'got=' + got.length);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
