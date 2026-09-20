var Akai=require("../akai.js"),fs=require("fs");
var d=Akai.load("DSKA0000.hfe",new Uint8Array(fs.readFileSync("E:\\DSKA0000.hfe")));
console.log("files:");
d.entries.forEach(function(e){
  console.log("  slot "+String(e.slot).padStart(2)+"  "+e.type+"  "+e.name.padEnd(11)+
    String(e.length).padStart(7)+" bytes  start "+String(e.startBlock).padStart(3)+
    "  blocks "+e.chainBlocks+(e.type==="S"?("  "+e.sampleCount+" words @"+e.sampleRate+
    "  ram 0x"+e.memoryAddress.toString(16)):""));
});
console.log("\nkeygroup chains:");
d.entries.filter(function(e){return e.type==="P";}).forEach(function(p){
  var kgs=d.keygroups(p);
  var base=d.keygroupArenaBase(p);
  console.log("  "+p.name+"   base 0x"+base.toString(16)+"   "+kgs.length+" keygroups");
  kgs.forEach(function(kg,i){
    var want=(i===kgs.length-1)?0:base+70*(i+1);
    console.log("     kg"+(i+1)+"  next 0x"+kg.nextKeygroup.toString(16).padStart(4,"0")+
      "   expected 0x"+want.toString(16).padStart(4,"0")+(kg.nextKeygroup===want?"":"   <-- WRONG")+
      "   keys "+kg.lowKey+"-"+kg.highKey+"  z1 '"+kg.zone1.name+"' ptr 0x"+kg.zone1.pointer.toString(16));
  });
});
