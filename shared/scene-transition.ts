/** The interaction audience and the state after that interaction are separate snapshots.
 * Only explicit first-person movement can change player presence; NPC prose alone cannot.
 */
export function playerDeparture(raw: string, replies: string[], location: string | null): { quote: string } | undefined {
  const speech = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu;
  const narration = raw.replace(speech, text => ' '.repeat(text.length));
  const remoteArrival = replies.some(text => /(?:目送|看着|看见)你[^。！？\n]{0,35}(?:进了|走进|进入|走远|离开)/u.test(text.replace(speech,'')));
  let firstPerson = false, departure: {quote:string} | undefined;
  for (const match of narration.matchAll(/[^，,。！？；;\n]+/gu)) {
    const quote = match[0].trim();
    if (!quote) continue;
    if (/如果|假如|想象|幻想|梦见|梦到|准备|打算|想要|希望|将要|明天|稍后|没有|并未|不会|不想|未曾|尚未/u.test(quote)) { firstPerson=false; continue; }
    if (/^(?:我|\*我)/u.test(quote)) firstPerson=true;
    else if (/^(?:她|他|你|他们|她们)/u.test(quote)) firstPerson=false;
    if (!firstPerson || /我(?:看|目送|听说|告诉|说|想起|记得)|心里|心想|觉得/u.test(quote)) continue;
    const explicit=/离开|离去|走出|走远|出门|迈出|离场|退出|(?:从|由).{0,30}(?:门|屋|室|房).{0,8}出去/u.test(quote);
    const headed=/(?:朝|往|向)[^，。！？]{1,24}(?:室|楼|宿舍|走廊)[^，。！？]{0,8}走去/u.test(quote);
    if (explicit || headed && remoteArrival) departure={quote};
    if (location && quote.includes(location) && /(?:走进|进入|回到|来到|抵达|到达)/u.test(quote)) departure=undefined;
  }
  return departure;
}
