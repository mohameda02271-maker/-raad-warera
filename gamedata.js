// Shared game data: real countries, Arabic display names, named regions.
import paths from './worldpaths.json' with { type: 'json' };
import neighborsOf from './neighbors.json' with { type: 'json' };

export const PATHS = paths;
export const NEIGHBORS = neighborsOf;

export const AR = {
    Egypt: 'مصر', Libya: 'ليبيا', Sudan: 'السودان', Israel: 'إسرائيل', Palestine: 'فلسطين',
    Jordan: 'الأردن', 'Saudi Arabia': 'السعودية', Syria: 'سوريا', Lebanon: 'لبنان', Iraq: 'العراق',
    Turkey: 'تركيا', Cyprus: 'قبرص', Greece: 'اليونان', Yemen: 'اليمن', Morocco: 'المغرب',
    Algeria: 'الجزائر', Tunisia: 'تونس', Chad: 'تشاد', Ethiopia: 'إثيوبيا', Eritrea: 'إريتريا',
    'United States of America': 'أمريكا', 'United Kingdom': 'بريطانيا', France: 'فرنسا', Germany: 'ألمانيا',
    Italy: 'إيطاليا', Spain: 'إسبانيا', Russia: 'روسيا', China: 'الصين', India: 'الهند', Japan: 'اليابان',
    Brazil: 'البرازيل', 'South Africa': 'جنوب أفريقيا', Nigeria: 'نيجيريا', Kenya: 'كينيا', Iran: 'إيران',
    Kuwait: 'الكويت', 'United Arab Emirates': 'الإمارات', Qatar: 'قطر', Oman: 'عُمان', Bahrain: 'البحرين',
    'S. Sudan': 'جنوب السودان', 'N. Cyprus': 'قبرص الشمالية', Somalia: 'الصومال', Djibouti: 'جيبوتي',
    Mali: 'مالي', Niger: 'النيجر', Pakistan: 'باكستان', Indonesia: 'إندونيسيا',
};
export const arName = (en) => AR[en] || en;

const DETAILED = {
    Egypt: ['القاهرة الكبرى', 'الإسكندرية والساحل', 'الدلتا', 'القناة وسيناء', 'الصعيد', 'البحر الأحمر والواحات'],
    Libya: ['طرابلس', 'بنغازي', 'فزان'],
    Sudan: ['الخرطوم', 'دارفور', 'كردفان'],
    Israel: ['تل أبيب', 'النقب', 'الجليل'],
    Palestine: ['غزة', 'الضفة'],
    Jordan: ['عمّان', 'العقبة'],
    'Saudi Arabia': ['الرياض', 'جدة', 'الدمام'],
    Syria: ['دمشق', 'حلب', 'اللاذقية'],
    Lebanon: ['بيروت', 'طرابلس'],
    Iraq: ['بغداد', 'البصرة', 'الموصل'],
    Turkey: ['إسطنبول', 'أنقرة', 'إزمير'],
    Greece: ['أثينا', 'سالونيك'],
    Cyprus: ['نيقوسيا', 'ليماسول'],
};

export function countryDefs() {
    const out = {};
    for (const id of Object.keys(PATHS)) {
        const named = DETAILED[id];
        out[id] = {
            id, name: arName(id),
            regions: named
                ? named.map((n, i) => ({ id: `${id}:${i}`, name: n, capital: i === 0, income: i === 0 ? 5 : 3, defense: i === 0 ? 30 : 15 }))
                : [{ id: `${id}:0`, name: arName(id), capital: true, income: 5, defense: 30 }],
        };
    }
    return out;
}
export const DEFS = countryDefs();
