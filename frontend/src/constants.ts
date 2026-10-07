import { Door, SubOption } from './types';

export const DOORS_CONFIG: Record<Door, SubOption[]> = {
  [Door.CLINICAL_FINDING]: [
    { id: 'disease', label: 'Disease / Disorder', ecl: '<< 64572001 |Disease (disorder)|' },
    { id: 'symptom', label: 'Symptom / Complaint', ecl: '<< 404684003 |Clinical finding (finding)| MINUS << 64572001 |Disease (disorder)|' },
    { id: 'test_result', label: 'Test Result Interpretation', ecl: '<< 118245000 |Measurement finding (finding)| OR << 441742003 |Evaluation finding (finding)|' }
  ],
  [Door.PROCEDURE_ACTION]: [
    { id: 'surgical', label: 'Surgical / Therapeutic', ecl: '<< 387713003 |Surgical procedure (procedure)| OR << 277132007 |Therapeutic procedure (procedure)|' },
    { id: 'diagnostic', label: 'Diagnostic / Screening', ecl: '<< 363615003 |Screening procedure (procedure)| OR << 306005004 |Diagnostic procedure (procedure)|' },
    { id: 'regime', label: 'Regime / Therapy', ecl: '<< 363787002 |Regime/Therapy|' },
    { id: 'edu_admin', label: 'Education / Administrative', ecl: '<< 409073007 |Education, guidance and counseling (procedure)| OR << 14734007 |Administrative procedure (procedure)|' }
  ],
  [Door.SITUATION_CONTEXT]: [
    { id: 'history', label: 'History Of...', ecl: '<< 160245001 |No longer present (situation)|' },
    { id: 'family_hx', label: 'Family History', ecl: '<< 57177007 |Family history with explicit context (situation)|' },
    { id: 'refusal', label: 'Refusal / Exception', ecl: '<< 183932001 |Procedure contraindicated (situation)| OR << 183944003 |Procedure refused (situation)|' }
  ],
  [Door.OBSERVABLE_ENTITY]: [
    { id: 'lab_path', label: 'Lab / Pathology', ecl: '<< 364712009 |Laboratory observable (observable entity)|' },
    { id: 'vital_signs', label: 'Physical / Vital Signs', ecl: '<< 363787002 |Observable entity| MINUS << 364712009 |Laboratory observable (observable entity)|' },
    { id: 'scores', label: 'Scores / Scales / Questionnaires', ecl: '<< 363787002 |Observable entity|' }
  ]
};
