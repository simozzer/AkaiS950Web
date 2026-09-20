var Akai=require("../akai.js"),fs=require("fs");
var d=Akai.load("x",new Uint8Array(fs.readFileSync("E:\\DSKA0000.hfe")));
var samples=d.entries.filter(function(e){return e.type==="S";}).sort(function(a,b){return a.slot-b.slot;});
console.log("samples in directory order:");
samples.forEach(function(s,i){ console.log("  ["+i+"] "+s.name); });

// every zone should point at base + 70 * (its sample's index); derive base from the majority
var votes={};
d.entries.filter(function(e){return e.type==="P";}).forEach(function(p){
  d.keygroups(p).forEach(function(kg){
    [kg.zone1,kg.zone2].forEach(function(z){
      if(!z.inUse) return;
      var idx=-1; samples.forEach(function(s,i){ if(s.name.trim().toUpperCase()===z.name.trim().toUpperCase()) idx=i; });
      if(idx<0||!z.pointer) return;
      var base=z.pointer-70*idx;
      votes[base]=(votes[base]||0)+1;
    });
  });
});
var base=Object.keys(votes).sort(function(a,b){return votes[b]-votes[a];})[0];
console.log("\nsample table base implied by the zones: 0x"+(+base).toString(16)+
            "   (agreed by "+votes[base]+" zone(s), "+Object.keys(votes).length+" different answers)");

console.log("\nzone pointers:");
d.entries.filter(function(e){return e.type==="P";}).forEach(function(p){
  d.keygroups(p).forEach(function(kg,k){
    [kg.zone1,kg.zone2].forEach(function(z,zi){
      if(!z.inUse) return;
      var idx=-1; samples.forEach(function(s,i){ if(s.name.trim().toUpperCase()===z.name.trim().toUpperCase()) idx=i; });
      var want=(+base)+70*idx;
      console.log("  "+p.name.padEnd(11)+" kg"+(k+1)+" z"+(zi+1)+"  '"+z.name.trim().padEnd(10)+
        "' idx "+idx+"  ptr 0x"+z.pointer.toString(16)+"  expected 0x"+want.toString(16)+
        (z.pointer===want?"":"   <-- WRONG, points at index "+((z.pointer-(+base))/70)));
    });
  });
});
