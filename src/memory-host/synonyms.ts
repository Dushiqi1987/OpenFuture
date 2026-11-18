/**
 * English biomedical abbreviation/synonym expansion for short scientific claims.
 *
 * SciFact-style claims are single sentences that often use an abbreviation while
 * the abstract spells the concept out (or vice versa). BM25 cannot bridge that
 * gap with stemming alone, so a claim query gets a small extra BM25 list built
 * from the expanded terms. The map is deliberately conservative: entries are
 * matched as whole lower-cased tokens only, so "mi" expands in "patients with mi"
 * but never inside "mild".
 */
const PAIRS: Array<[string, string]> = [
  ['covid-19', 'sars-cov-2 coronavirus'],
  ['sars-cov-2', 'covid-19 coronavirus'],
  ['sars', 'severe acute respiratory syndrome'],
  ['mers', 'middle east respiratory syndrome'],
  ['hiv', 'human immunodeficiency virus'],
  ['aids', 'acquired immunodeficiency syndrome'],
  ['tb', 'tuberculosis'],
  ['copd', 'chronic obstructive pulmonary disease'],
  ['cvd', 'cardiovascular disease'],
  ['mi', 'myocardial infarction'],
  ['chd', 'coronary heart disease'],
  ['hf', 'heart failure'],
  ['af', 'atrial fibrillation'],
  ['t2d', 'type 2 diabetes'],
  ['t1d', 'type 1 diabetes'],
  ['dm', 'diabetes mellitus'],
  ['nsclc', 'non-small cell lung cancer'],
  ['sclc', 'small cell lung cancer'],
  ['hcc', 'hepatocellular carcinoma'],
  ['crc', 'colorectal cancer'],
  ['bca', 'breast cancer'],
  ['pca', 'prostate cancer'],
  ['ms', 'multiple sclerosis'],
  ['ad', 'alzheimer disease'],
  ['pd', 'parkinson disease'],
  ['als', 'amyotrophic lateral sclerosis'],
  ['ra', 'rheumatoid arthritis'],
  ['oa', 'osteoarthritis'],
  ['ibd', 'inflammatory bowel disease'],
  ['uc', 'ulcerative colitis'],
  ['cd', 'crohn disease'],
  ['nafld', 'nonalcoholic fatty liver disease'],
  ['nash', 'nonalcoholic steatohepatitis'],
  ['aki', 'acute kidney injury'],
  ['ckd', 'chronic kidney disease'],
  ['uti', 'urinary tract infection'],
  ['ards', 'acute respiratory distress syndrome'],
  ['vte', 'venous thromboembolism'],
  ['dvt', 'deep vein thrombosis'],
  ['pe', 'pulmonary embolism'],
  ['ssri', 'selective serotonin reuptake inhibitor'],
  ['nsaid', 'nonsteroidal anti-inflammatory drug'],
  ['acei', 'angiotensin-converting enzyme inhibitor'],
  ['arb', 'angiotensin receptor blocker'],
  ['egfr', 'epidermal growth factor receptor'],
  ['vegf', 'vascular endothelial growth factor'],
  ['tnf', 'tumor necrosis factor'],
  ['il-6', 'interleukin 6'],
  ['crp', 'c-reactive protein'],
  ['bmi', 'body mass index'],
  ['hba1c', 'glycated hemoglobin'],
  ['ldl', 'low-density lipoprotein'],
  ['hdl', 'high-density lipoprotein']
]

const MAP = new Map(PAIRS)
const MAX_TERMS = 16

export function synonymTerms(query: string): string[] {
  const lower = query.toLowerCase()
  const tokens = new Set(lower.match(/[a-z0-9][a-z0-9-]*/g) ?? [])
  const expanded: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const expansion = MAP.get(token)
    if (!expansion) continue
    for (const term of expansion.split(/\s+/)) {
      const clean = term.replace(/[^a-z0-9-]/g, '')
      if (clean.length < 3 || tokens.has(clean) || seen.has(clean)) continue
      seen.add(clean)
      expanded.push(clean)
      if (expanded.length >= MAX_TERMS) return expanded
    }
  }
  return expanded
}
