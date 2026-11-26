const free=0xffffffff,end=0xfffffffe;
export function thumbnailCacheFixture({legacy=false, streamName="256_0123456789abcdef"}={}) {
  const data=Buffer.alloc((legacy?5:11)*512);
  Buffer.from("d0cf11e0a1b11ae1","hex").copy(data);
  const u16=(offset,value)=>data.writeUInt16LE(value,offset);
  const u32=(offset,value)=>data.writeUInt32LE(value,offset);
  u16(26,3); u16(28,0xfffe); u16(30,9); u16(32,6);
  u32(44,1); u32(48,1); u32(56,4096);
  u32(60,legacy?3:end); u32(64,legacy?1:0); u32(68,end);
  data.fill(0xff,76,1024); u32(76,0); u32(512,0xfffffffd); u32(516,end);
  const directory=(index,name,type,start,size,right=free,child=free)=>{
    const offset=1024+index*128;
    const nameBytes=Buffer.from(name+"\0","utf16le");
    nameBytes.copy(data,offset);
    u16(offset+64,nameBytes.length);
    data[offset+66]=type;
    u32(offset+68,free); u32(offset+72,right); u32(offset+76,child);
    u32(offset+116,start); u32(offset+120,size);
  };
  directory(0,"Root Entry",5,legacy?2:end,legacy?128:0,free,1);
  if(legacy){
    u32(520,end);u32(524,end);
    data.fill(0xff,2048);
    u32(2048,end);u32(2052,end);
    directory(1,"Catalog",2,0,16,2);
    directory(2,"1",2,1,24);
    u32(1536,0x00070010);u16(1540,1);
    u32(1600,12);Buffer.from("ffd8ffe0","hex").copy(data,1612);
  } else {
    directory(1,streamName,2,2,4096);
    for(let id=2;id<=9;id++) u32(512+id*4,id===9?end:id+1);
    u32(1536,24);u32(1540,3);u32(1544,4096-24);
    Buffer.from("ffd8ffe0","hex").copy(data,1560);
  }
  return data;
}
