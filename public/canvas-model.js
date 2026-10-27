export const CARD_WIDTH = 252;
export const CARD_HEIGHT = 324;
export function taskSources(task) {
  const media = task?.params?.kyyMedia || {};
  return [...new Set([...(task?.referenceImageIds || []), task?.inputImageId, ...(media.referenceImageIds || []), ...(media.referenceVideoIds || []), ...(media.referenceAudioIds || []), media.firstImageId, media.lastImageId].filter(Boolean))];
}
export function canvasGraph(state, projectId) {
  const shotIds = new Set(state.shots.filter(shot => shot.projectId === projectId).map(shot => shot.id));
  const project = state.projects.find(project => project.id === projectId);
  const tasks = state.tasks.filter(task => shotIds.has(task.shotId));
  const allMedia = [...state.assets, ...state.results];
  const mediaMap = new Map(allMedia.map(item => [item.id, item]));
  const taskMap = new Map(state.tasks.map(task => [task.id, task]));
  const visible = new Set(project?.canvas?.assetIds || []);
  for (const shot of state.shots) if (shotIds.has(shot.id)) for (const id of [...(shot.assetIds || []), shot.selectedImageId, shot.selectedVideoId].filter(Boolean)) visible.add(id);
  // Legacy assets have no projectId; show them on the active canvas until the user places them elsewhere.
  for (const asset of state.assets) if (asset.projectId === projectId || !asset.projectId) visible.add(asset.id);
  for (const result of state.results) if (shotIds.has(result.shotId)) visible.add(result.id);
  const visit = id => {
    const item = mediaMap.get(id);
    for (const parent of taskSources(taskMap.get(item?.taskId))) if (!visible.has(parent)) { visible.add(parent); visit(parent); }
  };
  for (const task of tasks) for (const source of taskSources(task)) visible.add(source);
  for (const id of [...visible]) visit(id);
  const nodes = allMedia.filter(item => visible.has(item.id)).map(item => ({ ...item, task:taskMap.get(item.taskId) }));
  for (const task of tasks) if (!state.results.some(result => result.taskId === task.id)) nodes.push({ id:task.id, kind:task.kind, name:task.prompt, createdAt:task.createdAt, task, pending:true });
  nodes.sort((a,b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
  const ids = new Set(nodes.map(node => node.id));
  const edges = nodes.flatMap(node => taskSources(node.task).filter(id => ids.has(id) && id !== node.id).map(id => ({from:id,to:node.id})));
  return { nodes, edges };
}
export function layoutGraph(graph, saved = {}) {
  const positions = {}, depth = new Map(), visiting = new Set();
  const parents = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) parents.get(edge.to)?.push(edge.from);
  function level(id) {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const result = Math.min(40, Math.max(0, ...(parents.get(id) || []).map(parent => level(parent) + 1)));
    visiting.delete(id); depth.set(id, result); return result;
  }
  const occupied = [];
  for (const node of graph.nodes) {
    const point = saved[node.id] || saved[node.task?.id];
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) { positions[node.id] = {...point}; occupied.push(point); }
  }
  for (const node of graph.nodes) {
    if (positions[node.id]) continue;
    const x = 80 + level(node.id) * 350;
    let y = 100;
    const height = graph.nodes.some(node => node.generator) ? 570 : CARD_HEIGHT;
    while (occupied.some(point => Math.abs(point.x-x)<CARD_WIDTH+32 && Math.abs(point.y-y)<height+40)) y += height + 60;
    positions[node.id] = {x,y}; occupied.push({x,y});
  }
  return positions;
}
export function preprocessingGraph(state, projectId) {
  const base = canvasGraph(state, projectId), canvas = state.projects.find(p => p.id === projectId)?.canvas || {};
  const hidden = new Set(canvas.hiddenNodeIds || []);
  const generators = (canvas.generators || []).map(node => ({...node, kind:'image', name:'生图节点', generator:true}));
  const generatorIds = new Set(generators.map(node => node.id));
  const nodes = [...base.nodes.filter(node => node.kind === 'image' && !hidden.has(node.id) && !hidden.has(node.task?.id)), ...generators];
  const ids = new Set(nodes.map(node => node.id));
  const edges = nodes.flatMap(node => node.generator
    ? node.referenceImageIds.map(from => ({from,to:node.id,draft:true}))
    : (generatorIds.has(node.task?.imageNodeId) ? [node.task.imageNodeId] : taskSources(node.task)).map(from=>({from,to:node.id}))
  ).filter(edge => ids.has(edge.from) && ids.has(edge.to));
  return {nodes,edges};
}
export function worldPoint(client, rect, view) { return { x:(client.x-rect.left-view.x)/view.zoom, y:(client.y-rect.top-view.y)/view.zoom }; }
export function zoomAt(view, zoom, point) {
  zoom = Math.max(.2, Math.min(2, zoom));
  const ratio = zoom / view.zoom;
  return { x:point.x-(point.x-view.x)*ratio, y:point.y-(point.y-view.y)*ratio, zoom };
}
