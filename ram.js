var Akai=require("./akai.js"),fs=require("fs");
var d=Akai.load("x",new Uint8Array(fs.readFileSync("E:\\DSKA0000.hfe")));
function ramSize(w){ return Math.floor((2*w+15)/16)*16; }

console.log("files:");
d.entries.forEach(function(e){
  console.log("  "+e.type+"  "+e.name.padEnd(11)+String(e.length).padStart(7)+" bytes"+
    (e.type==="S"?("   "+String(e.sampleCount).padStart(7)+" words @"+String(e.sampleRate).padStart(5)+
    "   ram 0x"+e.memoryAddress.toString(16).padStart(6,"0")+" + "+ramSize(e.sampleCount)):""));
});

var samples=d.samplesInOrder();
var last=samples[samples.length-1];
var top = last ? last.memoryAddress + ramSize(last.sampleCount) : 0x18000;
var used = top - 0x18000;

console.log("");
console.log("sample RAM base      : 0x18000  (98,304)");
console.log("top of sample data   : 0x"+top.toString(16)+"  ("+top.toLocaleString()+")");
console.log("sample memory needed : "+used.toLocaleString()+" bytes  ("+(used/1024).toFixed(1)+" KB)");
console.log("");
[[750,"750 KB - unexpanded S950"],[2250,"2.25 MB - fully expanded"]].forEach(function(m){
  var cap=m[0]*1024;
  console.log("  against "+m[1]+": "+(used<=cap?"fits":"DOES NOT FIT")+
    "   ("+(used/1024).toFixed(1)+" of "+m[0]+" KB, "+((used/cap)*100).toFixed(0)+"%)");
});

// how the library's own disks compare
var most=0, name="";
fs.readdirSync("E:\\").filter(function(f){return /\.hfe$/i.test(f)&&f!=="DSKA0000.hfe";}).forEach(function(f){
  var k=Akai.load(f,new Uint8Array(fs.readFileSync("E:\\"+f)));
  var s=k.samplesInOrder(); if(!s.length) return;
  var l=s[s.length-1], t=l.memoryAddress+ramSize(l.sampleCount)-0x18000;
  if(t>most){most=t;name=f;}
});
console.log("");
console.log("largest of the 100 original disks: "+name+"  "+(most/1024).toFixed(1)+" KB of sample memory");
