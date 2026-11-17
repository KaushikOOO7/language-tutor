// Catalog entries describe language choices, not a guarantee of provider accuracy.
const rows = [
  ['English','en','en-US','English'], ['Spanish','es','es-ES','Español'], ['French','fr','fr-FR','Français'],
  ['German','de','de-DE','Deutsch'], ['Italian','it','it-IT','Italiano'], ['Portuguese','pt','pt-BR','Português'],
  ['Kannada','kn','kn-IN','ಕನ್ನಡ'], ['Hindi','hi','hi-IN','हिन्दी'], ['Tamil','ta','ta-IN','தமிழ்'],
  ['Telugu','te','te-IN','తెలుగు'], ['Malayalam','ml','ml-IN','മലയാളം'], ['Bengali','bn','bn-IN','বাংলা'],
  ['Marathi','mr','mr-IN','मराठी'], ['Gujarati','gu','gu-IN','ગુજરાતી'], ['Punjabi','pa','pa-IN','ਪੰਜਾਬੀ'],
  ['Urdu','ur','ur-PK','اردو'], ['Assamese','as','as-IN','অসমীয়া'], ['Odia','or','or-IN','ଓଡ଼ିଆ'],
  ['Konkani','gom','gom-IN','कोंकणी'], ['Sanskrit','sa','sa-IN','संस्कृतम्'], ['Nepali','ne','ne-NP','नेपाली'],
  ['Sindhi','sd','sd-PK','سنڌي'], ['Kashmiri','ks','ks-IN','کٲشُر'], ['Maithili','mai','mai-IN','मैथिली'],
  ['Dogri','doi','doi-IN','डोगरी'], ['Bodo','brx','brx-IN','बड़ो'], ['Santali','sat','sat-IN','ᱥᱟᱱᱛᱟᱲᱤ'],
  ['Japanese','ja','ja-JP','日本語'], ['Korean','ko','ko-KR','한국어'], ['Mandarin','zh','zh-CN','中文'],
  ['Cantonese','yue','yue-HK','粵語'], ['Arabic','ar','ar-SA','العربية'], ['Russian','ru','ru-RU','Русский'],
  ['Ukrainian','uk','uk-UA','Українська'], ['Polish','pl','pl-PL','Polski'], ['Dutch','nl','nl-NL','Nederlands'],
  ['Swedish','sv','sv-SE','Svenska'], ['Norwegian','nb','nb-NO','Norsk'], ['Danish','da','da-DK','Dansk'],
  ['Finnish','fi','fi-FI','Suomi'], ['Icelandic','is','is-IS','Íslenska'], ['Greek','el','el-GR','Ελληνικά'],
  ['Turkish','tr','tr-TR','Türkçe'], ['Persian','fa','fa-IR','فارسی'], ['Hebrew','he','he-IL','עברית'],
  ['Indonesian','id','id-ID','Bahasa Indonesia'], ['Malay','ms','ms-MY','Bahasa Melayu'],
  ['Vietnamese','vi','vi-VN','Tiếng Việt'], ['Thai','th','th-TH','ไทย'], ['Filipino','fil','fil-PH','Filipino'],
  ['Burmese','my','my-MM','မြန်မာ'], ['Khmer','km','km-KH','ខ្មែរ'], ['Lao','lo','lo-LA','ລາວ'],
  ['Sinhala','si','si-LK','සිංහල'], ['Tibetan','bo','bo-CN','བོད་སྐད་'], ['Mongolian','mn','mn-MN','Монгол'],
  ['Kazakh','kk','kk-KZ','Қазақша'], ['Uzbek','uz','uz-UZ','Oʻzbekcha'], ['Azerbaijani','az','az-AZ','Azərbaycanca'],
  ['Armenian','hy','hy-AM','Հայերեն'], ['Georgian','ka','ka-GE','ქართული'], ['Pashto','ps','ps-AF','پښتو'],
  ['Swahili','sw','sw-KE','Kiswahili'], ['Zulu','zu','zu-ZA','isiZulu'], ['Afrikaans','af','af-ZA','Afrikaans'],
  ['Amharic','am','am-ET','አማርኛ'], ['Hausa','ha','ha-NG','Hausa'], ['Yoruba','yo','yo-NG','Yorùbá'],
  ['Igbo','ig','ig-NG','Igbo'], ['Somali','so','so-SO','Soomaali'], ['Romanian','ro','ro-RO','Română'],
  ['Hungarian','hu','hu-HU','Magyar'], ['Czech','cs','cs-CZ','Čeština'], ['Slovak','sk','sk-SK','Slovenčina'],
  ['Bulgarian','bg','bg-BG','Български'], ['Serbian','sr','sr-RS','Српски'], ['Croatian','hr','hr-HR','Hrvatski'],
  ['Slovenian','sl','sl-SI','Slovenščina'], ['Albanian','sq','sq-AL','Shqip'], ['Lithuanian','lt','lt-LT','Lietuvių'],
  ['Latvian','lv','lv-LV','Latviešu'], ['Estonian','et','et-EE','Eesti'], ['Catalan','ca','ca-ES','Català'],
  ['Basque','eu','eu-ES','Euskara'], ['Galician','gl','gl-ES','Galego'], ['Welsh','cy','cy-GB','Cymraeg'],
  ['Irish','ga','ga-IE','Gaeilge'], ['Maltese','mt','mt-MT','Malti'], ['Luxembourgish','lb','lb-LU','Lëtzebuergesch'],
  ['Esperanto','eo','eo-001','Esperanto'], ['Latin','la','la-001','Latina'], ['Haitian Creole','ht','ht-HT','Kreyòl ayisyen'],
  ['Quechua','qu','qu-PE','Runa simi'], ['Guarani','gn','gn-PY','Avañe’ẽ'], ['Māori','mi','mi-NZ','Te reo Māori'],
];
const scripts = { kn:['Knda'], hi:['Deva'], ta:['Taml'], te:['Telu'], ml:['Mlym'], bn:['Beng'], mr:['Deva'], gu:['Gujr'], pa:['Guru','Arab'], ur:['Arab'], as:['Beng'], or:['Orya'], gom:['Deva','Latn'], sa:['Deva'], ne:['Deva'], sd:['Arab','Deva'], ks:['Arab','Deva'], mai:['Deva'], doi:['Deva'], brx:['Deva'], sat:['Olck','Deva'], ja:['Jpan'], ko:['Kore'], zh:['Hans','Hant'], yue:['Hant'], ar:['Arab'], ru:['Cyrl'], uk:['Cyrl'], el:['Grek'], fa:['Arab'], he:['Hebr'], th:['Thai'], my:['Mymr'], km:['Khmr'], lo:['Laoo'], si:['Sinh'], bo:['Tibt'], mn:['Cyrl','Mong'], kk:['Cyrl'], hy:['Armn'], ka:['Geor'], ps:['Arab'], am:['Ethi'], bg:['Cyrl'], sr:['Cyrl','Latn'] };
const variants = { English:['en-US','en-GB','en-IN','en-AU'], Spanish:['es-ES','es-MX'], French:['fr-FR','fr-CA'], Portuguese:['pt-BR','pt-PT'], Arabic:['ar-SA','ar-EG'], Punjabi:['pa-IN','pa-PK'], Bengali:['bn-IN','bn-BD'], Mandarin:['zh-CN','zh-TW'] };
export const languageCatalog = rows.map(([name, code, locale, native]) => ({ name, code, locale, native, scripts: scripts[code] || ['Latn'], variants: variants[name] || [locale], direction: ['ar','ur','fa','he','ps','sd','ks'].includes(code) ? 'rtl' : 'ltr', translationCode: name === 'Mandarin' ? 'zh-Hans' : code }));
export const languageMap = Object.fromEntries(languageCatalog.map(language => [language.name, language]));
export const scriptNames = { Latn:'Latin', Deva:'Devanagari', Knda:'Kannada', Taml:'Tamil', Telu:'Telugu', Mlym:'Malayalam', Beng:'Bengali', Gujr:'Gujarati', Guru:'Gurmukhi', Arab:'Arabic', Orya:'Odia', Olck:'Ol Chiki', Cyrl:'Cyrillic', Hans:'Simplified Chinese', Hant:'Traditional Chinese', Jpan:'Japanese', Kore:'Korean', Grek:'Greek', Hebr:'Hebrew', Thai:'Thai', Mymr:'Myanmar', Khmr:'Khmer', Laoo:'Lao', Sinh:'Sinhala', Tibt:'Tibetan', Mong:'Mongolian', Armn:'Armenian', Geor:'Georgian', Ethi:'Ethiopic' };
