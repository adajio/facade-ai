import test from 'node:test';
import assert from 'node:assert/strict';
import {cadLock,companionFormat,desktopIni} from '../../../../dist/src/modules/formats/companion-files.js';
test('Windows and CAD sidecars require recognizable contents',()=>{
 assert.equal(companionFormat('folder/Desktop.INI'),'desktopini'); assert.equal(companionFormat('desktop-other.ini'),null);
 assert.equal(desktopIni(Buffer.from('[.ShellClassInfo]\nIconResource=x,1')).units[0].limitations[0],'windows_folder_settings');
 assert.equal(desktopIni(Buffer.from('[Survey]\nproject=true')).units[0].limitations[0],'format_original_only');
 const xml=Buffer.from('<?xml version="1.0" encoding="UTF-8">\n<whprops><username>Test</username><machinename>Room</machinename><fullname></fullname><datetime>26.11.2026</datetime></whprops>');
 const x=cadLock(xml,true).units[0], b=cadLock(Buffer.from('Test\nRoom\n26.11.2026'),false).units[0];
 assert.equal(x.limitations[0],'cad_lock_candidate');assert.equal(x.locator.lockPair,b.locator.lockPair);
 assert.equal(cadLock(Buffer.from('Chapter 1\nNotes'),false).units[0].limitations[0],'format_original_only');
 assert.equal(cadLock(Buffer.from('<whprops><note>26</note></whprops>'),true).units[0].limitations[0],'format_original_only');
});
