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
// Only unambiguous single-value rows are filled. Multi-model tables need review.
function parse(text) {
  const fields = {};
  const labels = {
    p:/(?:최대\s*출력(?!\s*(?:전압|전류))|정격\s*출력|maximum\s*power(?!\s*(?:voltage|current))|rated\s*power|Pmax)/i,
    voc:/(?:개방\s*전압|개방\s*회로\s*전압|open.?circuit\s*voltage|\bVoc\b)/i,
    vmp:/(?:최대\s*출력\s*전압|maximum\s*power\s*voltage|\bVmpp?\b)/i,
    isc:/(?:단락\s*전류|short.?circuit\s*current|\bIsc\b)/i,
    imp:/(?:최대\s*출력\s*전류|maximum\s*power\s*current|\bImpp?\b)/i,
    maxV:/(?:최대\s*시스템\s*전압|maximum\s*system\s*voltage)/i,
    maxSeriesFuse:/(?:최대.*퓨즈|maximum.*series.*fuse)/i,
    eff:/(?:모듈\s*효율|module\s*efficiency)/i
  };
  const candidates = {};
  let section = 'stc';
  for (const line of text.split('\n')) {
    if (/\bBNPI\b|후면.*(?:조사|일사)/i.test(line)) section = 'bnpi';
    else if (/\bSTC\b/i.test(line)) section = 'stc';
    if (/온도\s*계수|temperature\s*coefficient/i.test(line)) {
      const numbers = line.match(/[-−–]?\d+(?:[.,]\d+)?/g) || [];
      const key = /Voc|개방/i.test(line) ? 'betaVoc' : /Isc|단락/i.test(line) ? 'alphaIsc' : /Pmax|출력|power/i.test(line) ? 'gammaPower' : '';
      if (key && numbers.length === 1) (candidates[key] ||= []).push(Number(numbers[0].replace(/[−–]/g,'-').replace(',','.')));
      continue;
    }
    for (const [key,label] of Object.entries(labels)) {
      const match = label.exec(line);
      if (!match) continue;
      const tail = line.slice(match.index + match[0].length).replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '');
      const values = tail.match(/[-−]?\d+(?:[.,]\d+)?/g) || [];
      const target = section === 'bnpi' && ['p','voc','vmp','isc','imp'].includes(key) ? ({p:'bnpi',voc:'bnpiVoc',vmp:'bnpiVmp',isc:'bnpiIsc',imp:'bnpiImp'})[key] : key;
      if (values.length === 1) (candidates[target] ||= []).push(Number(values[0].replace('−','-').replace(',','.')));
    }
    for (const [key,label] of Object.entries({manufacturer:/^(?:제조사|manufacturer)\s*[:：]\s*(.+)$/i,series:/^(?:시리즈|series)\s*[:：]\s*(.+)$/i,name:/^(?:모델명?|model(?:\s*name)?)\s*[:：]\s*(.+)$/i})) {
      const match = line.trim().match(label);
      if (match) (candidates[key] ||= []).push(match[1].trim());
    }
  }
  for (const [key,values] of Object.entries(candidates)) if (new Set(values).size === 1) fields[key] = values[0];
  return fields;
}
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
    return {text:text.slice(0,60000), fields:parse(text), method, pages, page, previewImage, warning:text.trim() ? '' : '선택한 페이지에 추출할 텍스트가 없습니다. 텍스트 PDF를 사용하거나 원본을 보며 사양을 직접 입력하세요.'};
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT') throw problem('PDF 도구(Poppler)가 설치되지 않았습니다. docs/module-registration.md를 확인하세요.', 503);
    throw problem('PDF를 분석하지 못했습니다. 암호화·손상 여부를 확인하거나 다른 사양표 페이지를 선택하세요.', 422);
  } finally { active = false; if (temporary) await fs.rm(temporary,{recursive:true,force:true}); }
}
module.exports = {extract, parse, renderCommand};
