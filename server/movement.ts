// Independent host check of the app's bounded movement-evidence contract. This is
// conservative syntax validation, not a general natural-language geography proof.
const privateCue = /心想|暗想|暗忖|暗道|默念|默想|腹诽|没(?:有)?说出口|未说出口|没有出声|没出声|无声地?说|自言自语|内心独白|思忖|在心里说|心中说道|thought to (?:him|her|them)self|unspoken|under (?:his|her|their) breath/iu;
const nonActualCue = /如果|假如|假设|也许|可能|打算|计划(?:把|将|去|要)|想要|希望|准备要|准备把|会把|要把|梦见|梦到|幻想|(?:想起|回忆|记起)(?:了|着|当年|当时|上次|以前|曾)|(?:她|他|我|我们)(?:曾经|当年|上次|以前)(?:把|将|在|给)|^[\s“"「『]*(?:明天|明日|下周|稍后|待会儿?|之后)[，,\s]*(?:我|他|她|我们|他们|她们)?(?:就|会|再|要|把|将|去|给|交|还)/iu;
const movement = /离开|离去|退出|走出|走远|出门|迈出|离场|走进|进入|回到|来到|抵达|到达|走到|跨进|踏进/u;
const departure = /离开|离去|退出|走出|走远|出门|迈出|离场/u;
const arrival = /走进|进入|回到|来到|抵达|到达|走到|跨进|踏进/u;

export function validMovementEvidence(source: string, quote: string, destination: string | null, actorName?: string, narrativeName?: string): boolean {
  const narration = source.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, '');
  if (!quote.trim() || !narration.includes(quote) || !movement.test(quote) || privateCue.test(quote) || nonActualCue.test(quote)) return false;
  const blocks = source.split(/(?:\r?\n){2,}/u);
  if (!blocks.some((block, index) => {
    const previous = blocks[index - 1] ?? '';
    const attribution = previous.split(/[，,。！？；;\n]/u).map(part => part.trim()).filter(Boolean).at(-1) ?? '';
    const privateLead = /[:：]\s*$/u.test(previous) && privateCue.test(attribution) && /^\s*[“「『"]/u.test(block);
    return block.includes(quote) && !privateLead && !privateCue.test(block) && !nonActualCue.test(block);
  })) return false;
  const sentencePrefix = narration.slice(0, narration.lastIndexOf(quote)).split(/[。！？\n]/u).at(-1) ?? '';
  if (/准备|打算|将要|明天|明日|稍后|待会|下周|即将|没有|未曾|尚未|没能|不曾|并未|不会|不想|目送|看着|看见|望着|看到|等他|等她/u.test(sentencePrefix + quote)) return false;
  // narrativeName is an explicit author identity, never inferred from this reply.
  const escapedActor = [...(actorName?.split(/[|｜]/u) ?? []), narrativeName ?? ''].map(name => name.trim()).filter(Boolean).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const subject = escapedActor ? `(?:${escapedActor}|她|他|我)` : '(?:她|他|我)';
  if (!new RegExp(`^(?:${subject}(?:[，,\\s]|慢慢|缓缓|径直|随后|随即|终于|已经|又|便|就|独自|转身|轻轻)*)?(?:${movement.source})`).test((sentencePrefix + quote).trim().replace(/\*\*|__/gu,'').replace(/^\*+/, ''))) return false;
  const after = narration.slice(narration.lastIndexOf(quote) + quote.length);
  if (destination === null) {
    const last = [...quote.matchAll(new RegExp(departure.source, 'gu'))].at(-1);
    return !!last && !arrival.test(quote.slice(last.index! + last[0].length) + after);
  }
  const escaped = destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:走进|进入|回到|来到|抵达|到达|走到|跨进|踏进)[^。！？\n]{0,24}${escaped}`).test(quote)
    && !departure.test(quote.slice(quote.lastIndexOf(destination)) + after);
}
