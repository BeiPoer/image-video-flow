export function projectVideos(state, projectId) {
  const shots=new Set(state.shots.filter(shot=>shot.projectId===projectId).map(shot=>shot.id));
  const tasks=new Map(state.tasks.map(task=>[task.id,task]));
  return state.results.filter(result=>{
    const task=tasks.get(result.taskId);
    return result.kind==='video' && task?.status==='completed' && shots.has(result.shotId || task.shotId)
      && result.provider!=='local-demo' && typeof result.dataUrl==='string' && !result.dataUrl.startsWith('data:');
  });
}
