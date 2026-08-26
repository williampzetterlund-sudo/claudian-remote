import { query } from '@anthropic-ai/claude-agent-sdk';
const cwd = '/home/william/ignis/vaults/WZE';
let release;
const gate = new Promise(r => { release = r; });
async function* prompts() {
  await gate;  // vänta tills RC är armat
  console.log('>> skickar första prompten (efter RC)');
  yield { type: 'user', message: { role: 'user', content: 'Svara bara med ordet OK.' } };
  await new Promise(r => setTimeout(r, 170000));
}
const q = query({
  prompt: prompts(),
  options: { cwd, model: 'haiku', permissionMode: 'bypassPermissions',
    pathToClaudeCodeExecutable: '/home/william/.local/bin/claude',
    stderr: (s) => process.stderr.write('[stderr] ' + s) },
});
(async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') console.log('INIT session_id=', m.session_id);
    else if (m.type === 'result') console.log('RESULT:', m.subtype, (m.result||'').slice(0,80));
    else if (m.type === 'system') console.log('SYSTEM:', m.subtype, JSON.stringify(m).slice(0,200));
  }
})();
// Arma RC innan prompten — direkt, utan att vänta på init
(async () => {
  const t0 = Date.now();
  try {
    const r = await q.enableRemoteControl(true, 'ignis-rc-pretest');
    console.log(`ENABLE (pre-prompt, ${Date.now()-t0} ms):`, JSON.stringify(r));
  } catch (e) { console.log('ENABLE ERROR:', e?.message || e); }
  release();
})();
setTimeout(async () => {
  try { await q.enableRemoteControl(false); } catch {}
  q.close?.(); process.exit(0);
}, 180000);
