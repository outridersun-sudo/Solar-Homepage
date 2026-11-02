'use strict';
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const run = promisify(execFile);
// Prefer the OS Poppler build when present (its system font configuration is
// needed for unembedded fonts); otherwise use the normal PATH executable.
const renderCommand = process.env.MODULE_PDFTOPPM_BIN || (require('node:fs').existsSync('/usr/bin/pdftoppm') ? '/usr/bin/pdftoppm' : 'pdftoppm');
let active = false;
const problem = (message, status = 400) => Object.assign(new Error(message), {status});
const limits = {timeout:20000, maxBuffer:2 * 1024 * 1024, env:process.env};
const {analyze} = require('./module-pdf-parser');
const parse = text => analyze(text).fields;
async function extract(filename, page) {
  if (active) throw problem('다른 PDF를 분석 중입니다. 잠시 후 다시 시도하세요.', 429);
  active = true;
  let temporary;
  try {
    const info = await run('pdfinfo', [filename], limits);
    const pages = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!pages || pages > 100) throw problem('100페이지 이하의 PDF를 사용하세요.');
    if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw problem('사양표가 있는 페이지 번호를 확인하세요.');
    const result = await run('pdftotext', ['-f',String(page),'-l',String(page),'-layout',filename,'-'], limits);
    const text = result.stdout, method = 'text';
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'solar-module-pdf-'));
    const prefix = path.join(temporary,'page');
    await run(renderCommand, ['-f',String(page),'-l',String(page),'-singlefile','-scale-to','2400','-png',filename,prefix], {...limits, timeout:30000});
    const previewImage='data:image/png;base64,'+(await fs.readFile(prefix+'.png')).toString('base64');
    return {text:text.slice(0,60000), ...analyze(text), method, pages, page, previewImage};
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT') throw problem('PDF 도구(Poppler)가 설치되지 않았습니다. docs/module-registration.md를 확인하세요.', 503);
    throw problem('PDF를 분석하지 못했습니다. 암호화·손상 여부를 확인하거나 다른 사양표 페이지를 선택하세요.', 422);
  } finally { active = false; if (temporary) await fs.rm(temporary,{recursive:true,force:true}); }
}
module.exports = {extract, parse, renderCommand};
