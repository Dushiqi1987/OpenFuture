/**
 * Bilingual query expansion for CJK queries against English-heavy corpora.
 *
 * The embedding model (`bge-base-zh`) handles Chinese↔English semantically but
 * weakly on scientific text, and the lexical channels cannot match Chinese
 * characters against English words at all. A compact curated glossary bridges
 * that gap: it only *adds* an English BM25 list, so Chinese-only corpora are
 * unaffected (translated terms simply find nothing).
 */

const ENTRY_PAIRS: Array<[string, string]> = [
  ['多系统炎症综合征', 'multisystem inflammatory syndrome'],
  ['季节性流感', 'seasonal flu influenza'],
  ['免洗洗手液', 'hand sanitizer'],
  ['新型冠状病毒', 'sars-cov-2 novel coronavirus'],
  ['新冠病毒', 'sars-cov-2 covid-19 coronavirus'],
  ['冠状病毒', 'coronavirus'],
  ['候选疫苗', 'vaccine candidates'],
  ['mrna 疫苗', 'mrna vaccine'],
  ['新冠疫苗', 'covid-19 vaccine'],
  ['疫苗有效性', 'vaccine efficacy effectiveness'],
  ['中和抗体', 'neutralizing antibody'],
  ['免疫逃逸', 'immune escape'],
  ['长期症状', 'long covid post-acute sequelae'],
  ['辉瑞', 'pfizer bnt162b2'],
  ['莫德纳', 'moderna mrna-1273'],
  ['阿斯利康', 'astrazeneca'],
  ['强生', 'johnson johnson janssen'],
  ['疫苗', 'vaccine vaccination'],
  ['接种', 'vaccination'],
  ['亚型', 'subtype subtypes'],
  ['变异', 'variant variants mutation'],
  ['再感染', 'reinfection re-infection'],
  ['再次感染', 'reinfection'],
  ['免疫应答', 'immune response'],
  ['免疫反应', 'immune response'],
  ['t 细胞', 't-cell t cell'],
  ['抗体', 'antibody antibodies'],
  ['康复者', 'recovered patients convalescent'],
  ['康复', 'recovery recovered'],
  ['长期并发症', 'long-term complications'],
  ['并发症', 'complications'],
  ['维生素 d', 'vitamin d'],
  ['维生素', 'vitamin'],
  ['地塞米松', 'dexamethasone'],
  ['治疗', 'treatment therapy'],
  ['预防', 'prevention prevent'],
  ['证据', 'evidence'],
  ['暴力犯罪', 'violent crime'],
  ['犯罪', 'crime'],
  ['疫情', 'pandemic outbreak'],
  ['大流行', 'pandemic'],
  ['病毒载量', 'viral load'],
  ['传播', 'transmission spread'],
  ['症状', 'symptoms'],
  ['住院', 'hospitalization'],
  ['死亡率', 'mortality death rate'],
  ['儿童', 'children pediatric'],
  ['淋巴细胞减少', 'lymphopenia'],
  ['预后', 'prognosis'],
  ['洗手液', 'hand sanitizer'],
  ['口罩', 'mask face mask'],
  ['消毒', 'disinfection disinfect'],
  ['杀灭', 'destroy kill inactivate'],
  ['亚裔', 'asian-american'],
  ['非裔', 'african-american'],
  ['数据集', 'dataset'],
  ['亚型', 'subtypes'],
  ['流感', 'influenza flu'],
  ['世界卫生组织', 'world health organization who'],
  ['临床', 'clinical'],
  ['重症', 'severe critical'],
  ['轻症', 'mild'],
  ['肺', 'lung pulmonary'],
  ['血氧', 'oxygen saturation'],
  ['呼吸机', 'ventilator'],
  ['群体免疫', 'herd immunity'],
  ['新冠肺炎', 'covid-19 sars-cov-2'],
  ['免疫原性', 'immunogenicity'],
  ['临床试验', 'clinical trials'],
  ['随机对照', 'randomized controlled trial'],
  ['不良反应', 'adverse events side effects'],
  ['变异株', 'variant lineage clade'],
  ['奥密克戎', 'omicron'],
  ['德尔塔', 'delta variant'],
  ['封锁', 'lockdown'],
  ['社交距离', 'social distancing'],
  ['密切接触', 'close contact'],
  ['无症状', 'asymptomatic'],
  ['潜伏期', 'incubation period'],
  ['重症监护', 'intensive care'],
  ['死亡率', 'mortality fatality rate'],
  ['再感染率', 'reinfection rate'],
  ['免疫持续时间', 'durability of immunity'],
  ['疫苗犹豫', 'vaccine hesitancy']
]

const GLOSSARY = [...ENTRY_PAIRS].sort((a, b) => b[0].length - a[0].length)

export function bilingualQueryTerms(query: string): string[] {
  const normalized = query.toLowerCase().replace(/\s+/g, ' ')
  // Whitespace is unstable in Chinese text ("mRNA 疫苗" vs "mRNA疫苗"), so the
  // glossary is matched against a space-stripped copy of the query.
  const compact = normalized.replace(/\s+/g, '')
  const terms: string[] = []
  const seen = new Set<string>()
  for (const [zh, en] of GLOSSARY) {
    if (!compact.includes(zh.replace(/\s+/g, ''))) continue
    for (const word of en.split(/\s+/)) {
      if (!word) continue
      const clean = word.replace(/[^a-z0-9-]/g, '')
      if (clean.length < 2 || seen.has(clean)) continue
      seen.add(clean)
      terms.push(clean)
    }
  }
  return terms.slice(0, 24)
}
