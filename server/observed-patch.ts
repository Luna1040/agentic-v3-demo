import { isDeepStrictEqual } from 'node:util';
type Row=Record<string,any>;
const plain=(value:any):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** A partial observer writes only differences from the version they actually
 * received. Unseen head keys and unseen array members survive the mutation. */
export function mergeObservedState(head:any,observed:any,patch:any):any {
  if(isDeepStrictEqual(observed,patch))return structuredClone(head);
  if(plain(patch)){
    const result={...(plain(head)?head:{})};
    for(const [key,value] of Object.entries(patch)){
      if(isDeepStrictEqual(observed?.[key],value))continue;
      result[key]=mergeObservedState(head?.[key],observed?.[key],value);
    }
    return result;
  }
  if(Array.isArray(patch)&&Array.isArray(head)){
    const known=Array.isArray(observed)?observed:[];
    const result=head.filter(value=>!known.some(old=>isDeepStrictEqual(value,old))||patch.some(next=>isDeepStrictEqual(value,next)));
    for(const value of patch)if(!result.some(existing=>isDeepStrictEqual(existing,value)))result.push(structuredClone(value));
    return result;
  }
  return structuredClone(patch);
}
/** Share the current mutation, never unchanged fields copied from a head the
 * witness did not know. Nested objects receive the same field-level treatment. */
function overlay(old:any,before:any,after:any):any {
  if(isDeepStrictEqual(before,after))return old;
  if(plain(after)){
    const result={...(plain(old)?old:{})};
    for(const [key,value] of Object.entries(after)){
      if(isDeepStrictEqual(before?.[key],value))continue;
      const observed=overlay(old?.[key],before?.[key],value);
      if(observed!==undefined)result[key]=observed;
    }
    return result;
  }
  if(Array.isArray(after)&&Array.isArray(before)){
    // Appended public milestones can be learned without disclosing earlier
    // private milestones. Arbitrary array rewrites have no safe inferred delta.
    if(after.length>=before.length&&before.every((value,index)=>isDeepStrictEqual(value,after[index])))
      return [...(Array.isArray(old)?old:[]),...structuredClone(after.slice(before.length))];
    return old;
  }
  return structuredClone(after);
}
export function observedPatchSnapshot(input:{prior:Row;head:Row;old?:Row;patch:Row;witnessId:string;hiddenStateKeys:readonly string[];descriptionChanged:boolean}):Row {
  const {prior,head,old,witnessId}=input;
  const patch={...input.patch};for(const key of input.hiddenStateKeys)delete patch[key];
  return {...(old??{}),owner_id:head.owner_id,world_id:head.world_id,id:head.id,kind:head.kind,name:head.name,
    description:input.descriptionChanged?head.description:old?.description??'',state:overlay(old?.state??{},prior.state,patch),
    known_by_character_ids:[witnessId],version:head.version,source_turn_id:head.source_turn_id,created_at:old?.created_at??head.created_at,updated_at:head.updated_at,
    knowledgeScope:'partial'};
}
