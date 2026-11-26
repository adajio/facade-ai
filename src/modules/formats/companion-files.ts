import {createHash} from 'node:crypto';
import {originalOnly} from './model.js';

export function companionFormat(name: string) {
  const basename=name.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (basename==='desktop.ini') return 'desktopini';
  if (basename.endsWith('.dwl2')) return 'dwl2';
  if (basename.endsWith('.dwl')) return 'dwl';
  return null;
}

const key = (user:string,machine:string) => createHash('sha256').update(JSON.stringify([user,machine])).digest('hex');
const text = (bytes:Buffer) => {
  try {
    return new TextDecoder(bytes.subarray(0,2).equals(Buffer.from([0xff,0xfe]))?'utf-16le':'utf-8',{fatal:true}).decode(bytes).trim();
  } catch { return ''; }
};
export function desktopIni(bytes:Buffer) {
  const value=bytes.length<=16384 ? text(bytes) : '';
  const lines=value.split(/\r?\n/).map(line=>line.trim()).filter(line=>line && !line.startsWith(';'));
  const sections=new Set(['[.shellclassinfo]','[viewstate]']);
  let section='',recognized=false;
  const valid=lines.every(line=>{
    if (line.startsWith('[')){section=line.toLowerCase();return sections.has(section);}
    if (!section || !/^(iconresource|iconfile|iconindex|localizedresourcename|infotip|confirmfileop|mode|vid|foldertype)=/i.test(line)) return false;
    recognized=true;return true;
  });
  return originalOnly(valid && recognized ? 'windows_folder_settings' : 'format_original_only','original_only');
}

export function cadLock(bytes:Buffer, xml:boolean) {
  let pair;
  if (bytes.length>0 && bytes.length<=4096) {
    if(xml){
      // Some AutoCAD releases end their otherwise fixed XML declaration in ">".
      const match=/^(?:<\?xml version="1\.0" encoding="UTF-8"\??>\s*)?<whprops>\s*<username>([^<>\r\n]{1,128})<\/username>\s*<machinename>([^<>\r\n]{1,255})<\/machinename>\s*<fullname>[^<>]*<\/fullname>\s*<datetime>[^<>]*\d[^<>]*<\/datetime>\s*<\/whprops>$/i.exec(text(bytes));
      if(match)pair=key(match[1].trim(),match[2].trim());
    }else{
      const lines=bytes.toString('latin1').trim().split(/\r?\n/);
      if(lines.length===3 && lines.slice(0,2).every(line=>/^[\x20-\x7e]{1,255}$/.test(line)) && /\d/.test(lines[2]) && !/[\x00-\x08]/.test(lines[2]))pair=key(lines[0].trim(),lines[1].trim());
    }
  }
  const result=originalOnly(pair?'cad_lock_candidate':'format_original_only','original_only');
  if(pair)result.units[0].locator.lockPair=pair;
  return result;
}
