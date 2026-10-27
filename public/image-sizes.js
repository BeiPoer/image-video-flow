export const imageRatios = [
  {label:'1:1', size:'1024x1024', width:24, height:24},
  {label:'3:4', size:'1152x1536', width:18, height:24},
  {label:'4:3', size:'1536x1152', width:24, height:18},
  {label:'9:16', size:'864x1536', width:13.5, height:24},
  {label:'16:9', size:'1536x864', width:24, height:13.5},
];
// Retain saved legacy sizes without silently changing existing drafts.
export const imageSizes = [...imageRatios.map(ratio=>ratio.size), 'auto', '1024x1536', '1536x1024'];
