// Non-model acceptance for the packaged Codex route. Never runs during onboarding.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_PERMISSION_PROFILE, buildCodexInvocation, buildCodexSandboxCommand, codexIsolationEnvelope } from './codex-adapter.ts';

export function validateAcceptance(probes) {
  const required = ['workspaceRead', 'sourceRead', 'sourceWriteDenied', 'parentReadDenied', 'evidenceReadDenied', 'protectedReadDenied', 'workspaceMetadataWriteDenied', 'sensitiveReadDenied'];
  const failed = !probes ? required : required.filter(key => probes[key] !== true);
  if (failed.length > 0) throw new Error(`The host sandbox did not enforce every declared isolation boundary (${failed.join(', ')}${probes?.sensitiveReadable?.length ? ': ' + probes.sensitiveReadable.join(', ') : ''}); dispatch remains disabled.`);
  return { authoritativeRepositoryDenied: false, outsideWorkspaceReadsDenied: true, protectedEvidenceDenied: true,
    registeredProjectReadsAllowed: true, unassignedProjectWritesDenied: true, protectedPathsDenied: true, parentUserDirectoryDenied: true };
}

export function runAcceptance({ config, workspace, receiptPath }, execute = execFileSync) {
  if (process.platform !== 'win32' || !config.assignedProjectRoot) throw new Error('Packaged acceptance requires the supported Windows project-scoped Codex route.');
  const id = randomUUID();
  const sourceCanary = join(config.assignedProjectRoot, '.amadeus-acceptance-' + id);
  const evidenceCanary = join(dirname(receiptPath), '.amadeus-acceptance-' + id);
  try {
    writeFileSync(sourceCanary, 'Amadeus synthetic acceptance fixture', { flag: 'wx' });
    writeFileSync(evidenceCanary, 'Amadeus synthetic acceptance fixture', { flag: 'wx' });
    const permission = buildCodexInvocation(config, workspace, 'non-model-acceptance').find(arg => arg.startsWith('permissions.' + CODEX_PERMISSION_PROFILE + '='));
    const inputs = { sourceCanary, evidenceCanary, workspaceMetadata: join(workspace, '.worker-isolation.json'), parent: dirname(config.assignedProjectRoot), protectedPaths: config.protectedPaths,
      // A folder whose children are each denied (AppData\Roaming) may still list names under MXC; verify the children.
      sensitivePaths: (config.deniedSensitivePaths ?? []).filter(p => !(config.deniedSensitivePaths ?? [])
        .some(other => other.toLowerCase().startsWith(p.toLowerCase() + '\\'))) };
    const code = `const fs=require('node:fs'); const x=JSON.parse(process.argv[1]);
      function file(path,flags){try{const h=fs.openSync(path,flags);fs.closeSync(h);return true;}catch(e){if(['EACCES','EPERM'].includes(e.code))return false;throw e;}}
      function directory(path){try{const h=fs.opendirSync(path);h.closeSync();return true;}catch(e){if(['EACCES','EPERM'].includes(e.code))return false;throw e;}}
      const checks={workspaceRead:file(x.workspaceMetadata,'r'),sourceRead:file(x.sourceCanary,'r'),sourceWriteDenied:!file(x.sourceCanary,'r+'),parentReadDenied:!directory(x.parent),evidenceReadDenied:!file(x.evidenceCanary,'r'),workspaceMetadataWriteDenied:!file(x.workspaceMetadata,'r+')};
      checks.protectedReadDenied=x.protectedPaths.every(p=>{try{const h=fs.openSync(p,'r');fs.closeSync(h);return false;}catch(e){if(['EACCES','EPERM','ENOENT'].includes(e.code))return true;if(e.code==='EISDIR')return !directory(p);throw e;}});
      const sensitiveDenied=p=>{try{const h=fs.opendirSync(p);h.closeSync();return false;}catch(e){if(['EACCES','EPERM','ENOENT'].includes(e.code))return true;if(e.code==='ENOTDIR'){try{const h=fs.openSync(p,'r');fs.closeSync(h);return false;}catch(f){return ['EACCES','EPERM','ENOENT'].includes(f.code);}}throw e;}};
      checks.sensitiveReadable=x.sensitivePaths.filter(p=>!sensitiveDenied(p));
      checks.sensitiveReadDenied=checks.sensitiveReadable.length===0;
      console.log(JSON.stringify(checks));`;
    const args = buildCodexSandboxCommand(config, workspace, permission, process.execPath, ['-e', code, JSON.stringify(inputs)]);
    const environment = { ...process.env }; delete environment.OPENAI_API_KEY; delete environment.CODEX_API_KEY;
    const output = execute(config.executable, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, env: environment });
    const probes = JSON.parse(output.trim()); const verified = validateAcceptance(probes);
    // Remove canaries before binding the final filesystem/ACL state.
    rmSync(sourceCanary); rmSync(evidenceCanary);
    const envelope = codexIsolationEnvelope(config, workspace);
    writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, ...envelope, ...verified, testedAt: new Date().toISOString() }, null, 2) + '\n');
    return { passed: true, probes, modelInvoked: false };
  } finally {
    rmSync(sourceCanary, { force: true }); rmSync(evidenceCanary, { force: true });
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  if (arg('-Adapter') !== 'codex') throw new Error('Cursor requires its separately configured containment acceptance.');
  console.log(JSON.stringify(runAcceptance({ config: JSON.parse(readFileSync(arg('-ConfigPath'), 'utf8')), workspace: arg('-Workspace'), receiptPath: arg('-ReceiptPath') })));
}
