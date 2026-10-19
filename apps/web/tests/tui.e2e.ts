/** Built terminal clients share the real Web profile's state and recorded conversation projection. */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-user-questions'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, selectedSessionFixture } from './scaffold.ts'

it('shares recorded history, session changes, preferences and API recovery between two built terminal clients', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const fixture = await selectedSessionFixture(
    fileURLToPath(new URL('../../../snapshots/web/turn-tail-actions/session.v3.jsonl', import.meta.url)),
  )
  await seedSession(scaffold, await readFile(fixture, 'utf8'), 'tui-parallel-shared')
  await writeFile(new URL('binary.dat', 'file://' + scaffold.workspaceCwd + '/'), new Uint8Array([0, 1, 2, 255]))
  const entry = new URL('../../../apps/tui/lib/index.js', import.meta.url).href
  const code = `
    import { TuiModel, ApiTransport, transcript } from ${JSON.stringify(entry)};
    const make = () => new TuiModel(new ApiTransport(new URL(process.env.TUI_TEST_URL), 15000));
    const first = make(), second = make();
    const wait = async predicate => {
      const until = Date.now() + 10000;
      while (!predicate()) { if (Date.now() > until) throw new Error('Client observation timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    try {
      await first.start(); await second.start();
      const id = first.ctx.sessions.list.getSnapshot().ids.find(id => id === 'tui-parallel-shared');
      if (!id) throw new Error('Seeded session missing');
      await first.select(id); await second.select(id);
      await wait(() => transcript(first.chat(), first.renderers).join('\\n').includes('DONE'));
      const file = await first.ctx.remote.workspaceFiles.readBytes(id, 'binary.dat', {});
      const binary = file.ok && Buffer.from(file.value.data).equals(Buffer.from([0,1,2,255]));
      const firstText = transcript(first.chat(), first.renderers).join('\\n');
      const secondText = transcript(second.chat(), second.renderers).join('\\n');
      first.drafts.set(id, '/export');
      const sending = first.send('/export', 'queue');
      first.drafts.set(id, 'New unsent draft');
      first.attachments.set(id, [{type:'text',text:'New draft reference'}]);
      await sending;
      const newerDraftPreserved = first.drafts.get(id) === 'New unsent draft' && first.attachments.get(id)?.length === 1;
      first.attachments.delete(id);first.drafts.delete(id);
      const renamed = await first.binding.session.rename('Renamed in terminal');
      if (!renamed.ok) throw new Error(renamed.error.message);
      await wait(() => second.ctx.sessions.list.getSnapshot().byId[id]?.displayTitle === 'Renamed in terminal');
      const preference = await first.ctx.remote.settings.update('ui-conversation', { busyEnter: 'steer' }, undefined);
      if (!preference.ok) throw new Error(preference.error.message);
      await wait(() => second.busyEnter === 'steer');
      const generation = first.connection.generation.getSnapshot().id;
      first.connection.reconnect();
      await wait(() => (first.connection.generation.getSnapshot()?.id ?? 0) > generation);
      const archive = await first.transport.fetch('api/session.export?sessionId=' + encodeURIComponent(id));
      const bytes = new Uint8Array(await archive.arrayBuffer());
      const reconnected = first.connection.generation.getSnapshot().id > generation;
      await first.dispose();
      const result = await second.binding.session.rename('Still connected');
      if (!result.ok) throw new Error(result.error.message);
      console.log(JSON.stringify({ rendered: firstText, binary, newerDraftPreserved, sameTranscript: firstText === secondText, hasRecordedAnswer: firstText.includes('DONE'),
        hasRecordedTool: firstText.includes('bash'), title: result.value.title, preference: second.busyEnter,
        reconnected, archive: archive.ok && bytes[0] === 80 && bytes[1] === 75 }));
    } finally { await first.dispose(); await second.dispose(); }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env,
      TUI_TEST_URL: scaffold.baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onTestFinished(() => {
    if (child.exitCode === null) child.kill('SIGTERM')
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString()
  })
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  const codeResult = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  expect(stderr).toBe('')
  expect(codeResult).toBe(0)
  const result: unknown = JSON.parse(stdout.trim())
  if (typeof result !== 'object' || result === null || !('rendered' in result) || typeof result.rendered !== 'string') {
    throw new Error('Missing recorded terminal transcript')
  }
  const { rendered, ...summary } = result
  await expect(rendered.replaceAll(scaffold.workspaceCwd, '<workspace>')).toMatchFileSnapshot(
    fileURLToPath(new URL('../../../apps/tui/tests/expected/recorded-transcript.txt', import.meta.url)),
  )
  expect(summary).toEqual({
    binary: true,
    newerDraftPreserved: true,
    sameTranscript: true,
    hasRecordedAnswer: true,
    hasRecordedTool: true,
    title: 'Still connected',
    preference: 'steer',
    reconnected: true,
    archive: true,
  })
}, 60_000)

it('settles blocking and timed questions once across two terminal clients', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const entry = new URL('../../../apps/tui/lib/index.js', import.meta.url).href
  const code = `
    import { TuiModel, ApiTransport } from ${JSON.stringify(entry)};
    const make = () => new TuiModel(new ApiTransport(new URL(process.env.TUI_TEST_URL), 15000));
    const first=make(), second=make();
    const wait=async predicate => {
      const deadline=Date.now()+10000;
      while(!predicate()) { if(Date.now()>deadline) throw new Error('Question delivery timed out'); await new Promise(resolve=>setTimeout(resolve,10)); }
    };
    try {
      await first.start();await second.start();
      const id=await first.ctx.sessions.create({cwd:process.env.TUI_TEST_CWD});
      await first.select(id);await second.select(id);
      process.send({stage:'ready',sessionId:id});
      await wait(()=>first.interactions.length===1 && second.interactions.length===1);
      first.interactions[0].answer('A');
      await wait(()=>first.interactions.length===0 && second.interactions.length===0);
      process.send({stage:'blocking-settled'});
      await wait(()=>first.interactions.length===1 && second.interactions.length===1);
      second.interactions[0].answer('B');
      await wait(()=>first.interactions.length===0 && second.interactions.length===0);
      process.send({stage:'timed-settled'});
      await wait(()=>first.interactions.length===1 && second.interactions.length===1);
      await wait(()=>first.interactions.length===0 && second.interactions.length===0);
      process.send({stage:'expired'});
    } finally { await first.dispose();await second.dispose(); }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env,
      TUI_TEST_URL: scaffold.baseUrl,
      TUI_TEST_CWD: scaffold.workspaceCwd,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  onTestFinished(() => {
    if (child.exitCode === null) child.kill('SIGTERM')
  })
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  const stages: string[] = []
  let sessionId: string | undefined
  let stderr = ''
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    if ('stage' in message && typeof message.stage === 'string') stages.push(message.stage)
    if ('sessionId' in message && typeof message.sessionId === 'string') sessionId = message.sessionId
  })
  await expect.poll(() => sessionId).toBeDefined()
  if (!sessionId) throw new Error('Client did not create a session')
  const agent = scaffold.ctx.agents.get(SessionId(sessionId))
  if (!agent) throw new Error('Created session has no live Agent')
  const questions = [{ id: 'choice', question: 'Choose a result', options: [{ label: 'A' }, { label: 'B' }] }]
  expect(
    await Promise.race([
      scaffold.ctx.userQuestions.ask({ agent, questions }),
      ended.then((code) => {
        throw new Error(`Client exited ${code}: ${stderr}`)
      }),
    ]),
  ).toEqual({ answers: [{ id: 'choice', selected: ['A'] }] })
  await expect.poll(() => stages).toContain('blocking-settled')
  expect(
    await Promise.race([
      scaffold.ctx.userQuestions.askTimed({ agent, questions }, ToolCallId('tui-timed-question'), 5000),
      ended.then((code) => {
        throw new Error(`Client exited ${code}: ${stderr}`)
      }),
    ]),
  ).toEqual({ answers: [{ id: 'choice', selected: ['B'] }] })
  await expect.poll(() => stages).toContain('timed-settled')
  expect(
    await Promise.race([
      scaffold.ctx.userQuestions.askTimed({ agent, questions }, ToolCallId('tui-expiring-question'), 1000),
      ended.then((code) => {
        throw new Error(`Client exited ${code}: ${stderr}`)
      }),
    ]),
  ).toEqual({ pending: true, callId: ToolCallId('tui-expiring-question') })
  await expect.poll(() => stages).toContain('expired')
  const result = await ended
  expect(result).toBe(0)
  expect(stderr).toBe('')
}, 60_000)
