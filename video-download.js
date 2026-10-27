import https from 'node:https';
import {lookup} from 'node:dns';
import {isIP} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir,stat,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {publicImageAddress} from './image-source.js';

const fileLimit=256*1024*1024;
const activeDownloads=new Map();
function downloadError(message='视频下载失败，请检查视频地址是否已过期后重试') {return new Error(message);}

export async function remoteVideo(source,redirects=0) {
  let url;try{url=new URL(source);}catch{throw downloadError('视频地址无效');}
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(url.protocol!=='https:'||url.username||url.password||(isIP(host)&&!publicImageAddress(host)))throw downloadError('视频下载仅支持公网 HTTPS 地址');
  const response=await new Promise((resolve,reject)=>{
    const req=https.get(url,{
      signal:AbortSignal.timeout(180000),
      lookup(hostname,options,callback){lookup(hostname,{all:true},(err,addresses)=>{
        if(err||!addresses.length||addresses.some(item=>!publicImageAddress(item.address)))return callback(downloadError('视频地址不是可访问的公网地址'));
        if(options.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family);
      });},
    },resolve);
    req.on('error',()=>reject(downloadError()));
  });
  if([301,302,303,307,308].includes(response.statusCode)){
    const location=response.headers.location;response.destroy();
    if(!location||redirects>=3)throw downloadError('视频地址跳转过多或无效');
    let next;try{next=new URL(location,url).href;}catch{throw downloadError();}
    return remoteVideo(next,redirects+1);
  }
  const mime=response.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if(response.statusCode!==200 || (mime&&!['video/mp4','application/octet-stream','binary/octet-stream'].includes(mime))){response.destroy();throw downloadError();}
  if(Number(response.headers['content-length'])>fileLimit){response.destroy();throw downloadError('单个视频超过 256 MB 下载上限');}
  return response;
}

export async function videoFile(result,dataDir,openRemote=remoteVideo) {
  if(/^\/api\/video-results\/task-[a-f0-9-]+\.mp4$/.test(result.dataUrl || '')){
    const path=join(dataDir,'videos',result.dataUrl.split('/').pop());
    let info;try{info=await stat(path);}catch{throw downloadError('本地视频文件不存在，请检查数据目录');}
    if(!info.isFile()||!info.size||info.size>fileLimit)throw downloadError('本地视频为空或超过 256 MB');
    return {path,size:info.size};
  }
  const directory=join(dataDir,'video-downloads');
  const path=join(directory,createHash('sha256').update(String(result.dataUrl)).digest('hex')+'.mp4');
  if(activeDownloads.has(path))return activeDownloads.get(path);
  const job=(async()=>{
    await mkdir(directory,{recursive:true});
    try{const info=await stat(path);if(info.isFile()&&info.size>0&&info.size<=fileLimit)return {path,size:info.size};}catch(err){if(err.code!=='ENOENT')throw downloadError('无法读取视频缓存');}
    const temporary=path+'.'+randomUUID()+'.tmp';let bytes=0;
    try{
      const stream=await openRemote(result.dataUrl);
      const limit=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>fileLimit?downloadError('单个视频超过 256 MB 下载上限'):null,chunk);}});
      await pipeline(stream,limit,createWriteStream(temporary));
      if(!bytes)throw downloadError('下载到的视频为空');
      await rename(temporary,path);return {path,size:bytes};
    }catch(err){throw downloadError(err.message?.includes('256 MB')?'单个视频超过 256 MB 下载上限':undefined);}
    finally{await rm(temporary,{force:true});}
  })().finally(()=>activeDownloads.delete(path));
  activeDownloads.set(path,job);return job;
}

export function downloadName(name) {
  return (String(name||'视频').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/g,'').slice(0,80)||'视频')+'.mp4';
}

