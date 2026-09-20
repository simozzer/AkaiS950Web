var Akai=require("../akai.js"),fs=require("fs");
var src="E:\\DSKA0000.hfe", out="C:\\Users\\simon\\AkaiS950Web\\DSKA0000-repaired.hfe";
var d=Akai.load("DSKA0000.hfe",new Uint8Array(fs.readFileSync(src)));

console.log("before:");
console.log("  sample table base: 0x"+(d.sampleTableBase()||0).toString(16));
var z=d.repairZonePointers(), c=d.repairKeygroupChains();
console.log("repaired:");
console.log("  zone pointers corrected : "+z);
console.log("  chain terminators fixed : "+c);

var bytes=d.save();
fs.writeFileSync(out,Buffer.from(bytes));
console.log("  written: "+out+"  ("+bytes.length.toLocaleString()+" bytes)");

// and read it straight back
var r=Akai.load("check",new Uint8Array(fs.readFileSync(out)));
console.log("verify: "+r.entries.length+" files, "+r.badCrc+" bad-CRC, "+r.missing+" unreadable");
var samples=r.samplesInOrder(), base=r.sampleTableBase(), bad=0;
r.entries.filter(function(e){return e.type==="P";}).forEach(function(p){
  r.keygroups(p).forEach(function(kg,k){
    [kg.zone1,kg.zone2].forEach(function(zo,zi){
      if(!zo.inUse) return;
      var i=r.sampleIndex(zo.name);
      if(zo.pointer!==base+70*i){ bad++; console.log("  STILL WRONG: "+p.name+" kg"+(k+1)); }
    });
    var last=(k===r.keygroups(p).length-1);
    if(last&&kg.nextKeygroup!==0){ bad++; console.log("  STILL WRONG chain: "+p.name+" kg"+(k+1)); }
  });
});
console.log("  zone pointers and chains now consistent: "+(bad===0));
