/*
 * Analyseurs éprouvés par tests/clickhouse/analyseurs.mjs et scripts/test.mjs.
 * ATTENDUS : résultats publiés dans la documentation d’Elasticsearch (API _analyze, page de chaque tokenizer ou filtre).
 */
export const TEXTES = [
  "The 2 QUICK Brown-Foxes jumped over the lazy dog's bone.",
  'Quick Fox',
  "The foo_bar_size's default is 5.",
  'a quick fox jumps over the lazy dog',
  'açaí à la carte',
  "L'avion d'Air France, l’ami",
  '/one/two/three',
  'user@example.com 10.0.0.1 3.14s déjà-vu',
  '  espaces   multiples  ',
  'ÉCOLE Straße Œuvre',
  ''
];

export const CAS = [
  { nom: 'standard', spec: 'standard' },
  { nom: 'simple', spec: 'simple' },
  { nom: 'whitespace', spec: 'whitespace' },
  { nom: 'keyword', spec: 'keyword' },
  { nom: 'stop', spec: 'stop' },
  { nom: 'pattern', spec: 'pattern' },
  {
    nom: 'custom whitespace+lowercase+asciifolding',
    spec: { tokenizer: 'whitespace', filter: ['lowercase', 'asciifolding'] }
  },
  { nom: 'custom letter+uppercase', spec: { tokenizer: 'letter', filter: ['uppercase'] } },
  { nom: 'custom standard+lowercase+stop', spec: { tokenizer: 'standard', filter: ['lowercase', 'stop'] } },
  {
    nom: 'custom standard+lowercase+unique+length',
    spec: { tokenizer: 'standard', filter: ['lowercase', 'unique', { type: 'length', min: 2, max: 6 }] }
  },
  {
    nom: 'custom standard+truncate+reverse',
    spec: { tokenizer: 'standard', filter: [{ type: 'truncate', length: 4 }, 'reverse'] }
  },
  { nom: 'custom elision', spec: { tokenizer: 'standard', filter: ['lowercase', 'elision'] } },
  {
    nom: 'ngram tokenizer',
    spec: {
      tokenizer: { type: 'ngram', min_gram: 2, max_gram: 3, token_chars: ['letter', 'digit'] },
      filter: ['lowercase']
    }
  },
  { nom: 'ngram tokenizer sans token_chars', spec: { tokenizer: { type: 'ngram' } } },
  {
    nom: 'edge_ngram tokenizer',
    spec: {
      tokenizer: { type: 'edge_ngram', min_gram: 1, max_gram: 4, token_chars: ['letter'] },
      filter: ['lowercase']
    }
  },
  {
    nom: 'edge_ngram filtre',
    spec: { tokenizer: 'whitespace', filter: ['lowercase', { type: 'edge_ngram', min_gram: 2, max_gram: 5 }] }
  },
  {
    nom: 'ngram filtre',
    spec: { tokenizer: 'whitespace', filter: ['lowercase', { type: 'ngram', min_gram: 2, max_gram: 3 }] }
  },
  { nom: 'path_hierarchy', spec: { tokenizer: 'path_hierarchy' } },
  {
    nom: 'char_group',
    spec: { tokenizer: { type: 'char_group', tokenize_on_chars: ['whitespace', '-', '@', '.'] }, filter: ['lowercase'] }
  },
  {
    nom: 'pattern tokenizer (groupe)',
    spec: { tokenizer: { type: 'pattern', pattern: '([a-z]+)', group: 1 }, filter: ['lowercase'] }
  },
  {
    nom: 'pattern_replace char_filter',
    spec: {
      char_filter: [{ type: 'pattern_replace', pattern: '[0-9]+', replacement: '#' }],
      tokenizer: 'standard',
      filter: ['lowercase']
    }
  },
  {
    nom: 'mapping char_filter',
    spec: {
      char_filter: [{ type: 'mapping', mappings: ['é => e', 'ç => c', 'ß => ss'] }],
      tokenizer: 'standard',
      filter: ['lowercase']
    }
  },
  {
    nom: 'pattern_replace filtre',
    spec: { tokenizer: 'whitespace', filter: [{ type: 'pattern_replace', pattern: '(\\d+)', replacement: '<$1>' }] }
  },
  {
    nom: 'stop personnalisée',
    spec: { tokenizer: 'standard', filter: ['lowercase', { type: 'stop', stopwords: ['quick', 'lazy'] }] }
  },
  {
    nom: 'synonymes simples',
    spec: {
      tokenizer: 'standard',
      filter: ['lowercase', { type: 'synonym', synonyms: ['quick, fast, rapid', 'dog => hound'] }]
    }
  }
];

// Résultats de la documentation d’Elasticsearch : [spec, texte, mots attendus]
export const ATTENDUS = [
  [
    { tokenizer: 'standard' },
    "The 2 QUICK Brown-Foxes jumped over the lazy dog's bone.",
    ['The', '2', 'QUICK', 'Brown', 'Foxes', 'jumped', 'over', 'the', 'lazy', "dog's", 'bone']
  ],
  [
    { tokenizer: 'whitespace' },
    "The 2 QUICK Brown-Foxes jumped over the lazy dog's bone.",
    ['The', '2', 'QUICK', 'Brown-Foxes', 'jumped', 'over', 'the', 'lazy', "dog's", 'bone.']
  ],
  [
    { tokenizer: 'letter' },
    "The 2 QUICK Brown-Foxes jumped over the lazy dog's bone.",
    ['The', 'QUICK', 'Brown', 'Foxes', 'jumped', 'over', 'the', 'lazy', 'dog', 's', 'bone']
  ],
  [
    { tokenizer: 'lowercase' },
    "The 2 QUICK Brown-Foxes jumped over the lazy dog's bone.",
    ['the', 'quick', 'brown', 'foxes', 'jumped', 'over', 'the', 'lazy', 'dog', 's', 'bone']
  ],
  [
    { tokenizer: 'ngram' },
    'Quick Fox',
    ['Q', 'Qu', 'u', 'ui', 'i', 'ic', 'c', 'ck', 'k', 'k ', ' ', ' F', 'F', 'Fo', 'o', 'ox', 'x']
  ],
  [{ tokenizer: 'edge_ngram' }, 'Quick Fox', ['Q', 'Qu']],
  [{ tokenizer: 'pattern' }, "The foo_bar_size's default is 5.", ['The', 'foo_bar_size', 's', 'default', 'is', '5']],
  [{ tokenizer: 'path_hierarchy' }, '/one/two/three', ['/one', '/one/two', '/one/two/three']],
  [
    { tokenizer: 'standard', filter: ['stop'] },
    'a quick fox jumps over the lazy dog',
    ['quick', 'fox', 'jumps', 'over', 'lazy', 'dog']
  ],
  [{ tokenizer: 'standard', filter: ['asciifolding'] }, 'açaí à la carte', ['acai', 'a', 'la', 'carte']],
  [
    { tokenizer: 'standard', filter: ['unique'] },
    'the quick fox jumps the lazy fox',
    ['the', 'quick', 'fox', 'jumps', 'lazy']
  ],
  [
    { tokenizer: 'standard', filter: [{ type: 'length', min: 0, max: 4 }] },
    'the quick fox jumps over the lazy dog',
    ['the', 'fox', 'over', 'the', 'lazy', 'dog']
  ],
  [
    { tokenizer: 'standard', filter: ['lowercase', { type: 'edge_ngram', min_gram: 1, max_gram: 2 }] },
    'the quick brown fox jumps',
    ['t', 'th', 'q', 'qu', 'b', 'br', 'f', 'fo', 'j', 'ju']
  ]
];
