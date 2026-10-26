import { ServiceError, type ActorInput, type RunTurnOptions, type StoryRuntime, type TurnResult } from './runtime.ts';

/** One explicit production entry. Capability inference is confined to legacy
 * artifacts/fixtures; it must not choose the modern application's semantics. */
export function dialogueExecution(runtime: StoryRuntime, input: ActorInput) {
  if (runtime.streamDialogue) {
    if (!input.worldContext || !runtime.settleWorldTurn)
      throw new ServiceError('WORLD_RUNTIME_UNAVAILABLE', '世界整理接口尚未就绪，请检查运行版本。', 503);
    return {run:runtime.streamDialogue.bind(runtime),living:true,deferred:true,actorFirst:true,phase:'responding' as const};
  }
  return legacyExecution(runtime,input);
}

function legacyExecution(runtime: StoryRuntime,input:ActorInput): {
  run: ((input:ActorInput,options:RunTurnOptions)=>Promise<TurnResult>)|undefined;
  living:boolean;deferred:boolean;actorFirst:boolean;phase:'planning'|'responding';
} {
  const living=Boolean(input.worldContext && runtime.runWorldTurn);
  const method=living?runtime.runWorldTurn:runtime.runTurn;
  return {run:method?.bind(runtime),living,deferred:living&&Boolean(runtime.settleWorldTurn),actorFirst:Boolean(runtime.planNextScene),
    phase:runtime.planNextScene&&input.operation!=='opening'?'responding':method?'planning':'responding'};
}
