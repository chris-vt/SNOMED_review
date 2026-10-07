import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  Door, 
  Concept, 
  AttributeFilter, 
  CriterionRule, 
  EvaluationResult, 
  ReviewSummaryItem, 
  ReviewFileContent,
  ConceptItem
} from './types';
import { DOORS_CONFIG } from './constants';
import * as api from './services/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const CURRENT_USER = "Dr. Clinical Advisor";

type LeftTab = 'codes' | 'recommendations' | 'details' | 'notes';
type CodeFilter = 'positives' | 'tp' | 'fp' | 'fn' | 'inactive';

export default function App() {
  // Navigation & Review selection state
  const [reviewsList, setReviewsList] = useState<ReviewSummaryItem[]>([]);
  const [selectedReviewId, setSelectedReviewId] = useState<string>('AST_COD');
  const [currentReview, setCurrentReview] = useState<ReviewFileContent | null>(null);
  const [isLoadingReview, setIsLoadingReview] = useState(false);
  const [leftTab, setLeftTab] = useState<LeftTab>('codes');
  const [codeFilter, setCodeFilter] = useState<CodeFilter>('positives');

  // Refset Builder State (Right Panel)
  const [activeDoor, setActiveDoor] = useState<Door>(Door.CLINICAL_FINDING);
  const [activeSubDomain, setActiveSubDomain] = useState<string>(DOORS_CONFIG[Door.CLINICAL_FINDING][0].id);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<Concept[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedRoot, setSelectedRoot] = useState<Concept | null>(null);
  const [attributes, setAttributes] = useState<AttributeFilter[]>([]);
  const [isLoadingAttrs, setIsLoadingAttrs] = useState(false);
  const [isAttributesOpen, setIsAttributesOpen] = useState(false);

  // Selected SNOMED Codes (under current root + constraints)
  const [selectedCodes, setSelectedCodes] = useState<Concept[]>([]);
  const [selectedCodesTotal, setSelectedCodesTotal] = useState<number>(0);
  const [isLoadingSelectedCodes, setIsLoadingSelectedCodes] = useState(false);

  // Active Criteria Stack (Rules currently applied)
  const [criteria, setCriteria] = useState<CriterionRule[]>([]);
  const [evalResult, setEvalResult] = useState<EvaluationResult | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);

  // Draft & Modal states
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [draftFilename, setDraftFilename] = useState('');
  const [reviewerNotes, setReviewerNotes] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // 1. Initial Load: list of reviews
  useEffect(() => {
    api.fetchReviews()
      .then(items => {
        setReviewsList(items);
        if (items.length > 0 && !items.some(i => i.id === selectedReviewId)) {
          setSelectedReviewId(items[0].id);
        }
      })
      .catch(err => console.error("Failed to fetch reviews list", err));
  }, []);

  // 2. Load Selected Review
  const loadReviewData = useCallback(async (id: string) => {
    setIsLoadingReview(true);
    try {
      const data = await api.fetchReview(id);
      setCurrentReview(data);
      
      const initialRules: CriterionRule[] = [];
      
      (data.initial_inclusions || []).forEach((inc: any, idx: number) => {
        initialRules.push({
          id: `inc_${idx}_${inc.concept_id}`,
          concept_id: inc.concept_id,
          term: inc.term || `Concept ${inc.concept_id}`,
          include_self: inc.include_self ?? true,
          is_exclusion: false,
          attributes: inc.attributes || [],
        });
      });

      (data.initial_exclusions || []).forEach((exc: any, idx: number) => {
        initialRules.push({
          id: `exc_${idx}_${exc.concept_id}`,
          concept_id: exc.concept_id,
          term: exc.term || `Concept ${exc.concept_id}`,
          include_self: exc.include_self ?? true,
          is_exclusion: true,
          attributes: exc.attributes || [],
        });
      });

      setCriteria(initialRules);
      setReviewerNotes(data.draft?.notes || '');
      showToast(`Loaded ${data.target_refset} ${data.is_draft ? '(Draft)' : '(Baseline)'}`);
    } catch (err) {
      console.error("Failed to load review", err);
      showToast("Error loading review from backend.");
    } finally {
      setIsLoadingReview(false);
    }
  }, []);

  useEffect(() => {
    if (selectedReviewId) {
      loadReviewData(selectedReviewId);
    }
  }, [selectedReviewId, loadReviewData]);

  // 3. Recalculate Criteria Impact whenever criteria stack changes
  useEffect(() => {
    if (!currentReview) return;

    const inclusions = criteria
      .filter(c => !c.is_exclusion)
      .map(c => ({
        concept_id: c.concept_id,
        term: c.term,
        include_self: c.include_self,
        attributes: c.attributes,
      }));

    const exclusions = criteria
      .filter(c => c.is_exclusion)
      .map(c => ({
        concept_id: c.concept_id,
        term: c.term,
        include_self: c.include_self,
        attributes: c.attributes,
      }));

    setIsEvaluating(true);
    api.evaluateCriteria(currentReview.target_refset, inclusions, exclusions)
      .then(res => setEvalResult(res))
      .catch(err => console.error("Evaluation error", err))
      .finally(() => setIsEvaluating(false));
  }, [criteria, currentReview]);

  // 4. Update "Snomed codes selected" preview whenever selectedRoot or attributes change
  useEffect(() => {
    if (!selectedRoot) {
      setSelectedCodes([]);
      setSelectedCodesTotal(0);
      return;
    }

    const activeAttrs = attributes
      .map(attr => ({
        type_id: parseInt(attr.attributeId, 10),
        value_ids: attr.options.filter(o => o.checked).map(o => parseInt(o.valueId, 10)),
      }))
      .filter(a => a.value_ids.length > 0);

    setIsLoadingSelectedCodes(true);
    api.previewFilteredCodes(selectedRoot.id, activeAttrs)
      .then(res => {
        // Sort alphabetically by term
        const sorted = [...res.codes].sort((a, b) => a.term.localeCompare(b.term));
        setSelectedCodes(sorted);
        setSelectedCodesTotal(res.total_count);
      })
      .catch(err => console.error("Preview filtered codes error", err))
      .finally(() => setIsLoadingSelectedCodes(false));
  }, [selectedRoot, attributes]);

  // Search Handler
  const handleSearch = async () => {
    if (!searchTerm.trim()) return;
    setIsSearching(true);
    setHasSearched(true);
    try {
      const results = await api.searchConcepts(searchTerm);
      // Alphabetical order
      const sorted = [...results].sort((a, b) => a.term.localeCompare(b.term));
      setSearchResults(sorted);
    } catch (e) {
      console.error(e);
      showToast("Search failed. Check backend connection.");
    } finally {
      setIsSearching(false);
    }
  };

  // Select Root & Introspect Attributes (collapses search list)
  const handleSelectRoot = async (concept: Concept) => {
    setSelectedRoot(concept);
    setSearchResults([]);
    setIsLoadingAttrs(true);
    setAttributes([]);
    try {
      const attrs = await api.introspectAttributes(concept.id);
      setAttributes(attrs);
    } catch (e) {
      console.error(e);
      showToast("Failed to introspect attributes for concept.");
    } finally {
      setIsLoadingAttrs(false);
    }
  };

  // Change Root: clear root and allow new search
  const handleChangeRoot = () => {
    setSelectedRoot(null);
    setAttributes([]);
    setSelectedCodes([]);
    setSelectedCodesTotal(0);
    setSearchResults([]);
    setHasSearched(false);
  };

  // Clicking an active criteria card autopopulates the criteria selection builder
  const handleSelectExistingCriteria = async (crit: CriterionRule) => {
    const conceptObj: Concept = {
      id: crit.concept_id.toString(),
      term: crit.term,
    };
    setSelectedRoot(conceptObj);
    setSearchResults([]);
    setIsLoadingAttrs(true);
    try {
      const attrs = await api.introspectAttributes(conceptObj.id);
      const populated = attrs.map(a => {
        const matchingRuleAttr = crit.attributes.find(ra => ra.type_id.toString() === a.attributeId);
        if (matchingRuleAttr) {
          const checkedSet = new Set(matchingRuleAttr.value_ids.map(v => v.toString()));
          return {
            ...a,
            options: a.options.map(opt => ({
              ...opt,
              checked: checkedSet.has(opt.valueId),
            })),
          };
        }
        return a;
      });
      setAttributes(populated);
      showToast(`Loaded rule: ${crit.term}`);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingAttrs(false);
    }
  };

  // Toggle attribute checkbox
  const handleToggleAttributeOption = (attrIndex: number, optIndex: number) => {
    setAttributes(prev => {
      const copy = prev.map((a, aI) => {
        if (aI !== attrIndex) return a;
        return {
          ...a,
          options: a.options.map((o, oI) => {
            if (oI !== optIndex) return o;
            return { ...o, checked: !o.checked };
          }),
        };
      });
      return copy;
    });
  };

  // Add rule to criteria stack
  const handleAddRule = (isExclusion: boolean) => {
    if (!selectedRoot) return;

    const activeAttrs = attributes
      .map(attr => ({
        type_id: parseInt(attr.attributeId, 10),
        value_ids: attr.options.filter(o => o.checked).map(o => parseInt(o.valueId, 10)),
        attributeName: attr.name,
        valueTerms: attr.options.filter(o => o.checked).map(o => o.label),
      }))
      .filter(a => a.value_ids.length > 0);

    const newRule: CriterionRule = {
      id: `${isExclusion ? 'exc' : 'inc'}_${Date.now()}`,
      concept_id: parseInt(selectedRoot.id, 10),
      term: selectedRoot.term,
      include_self: true,
      is_exclusion: isExclusion,
      attributes: activeAttrs,
    };

    setCriteria(prev => [...prev, newRule]);
    showToast(`Added ${isExclusion ? 'Exclusion' : 'Inclusion'}: ${selectedRoot.term}`);
  };

  const handleRemoveRule = (ruleId: string) => {
    setCriteria(prev => prev.filter(c => c.id !== ruleId));
  };

  // Save Draft Action
  const handleOpenSaveModal = () => {
    // If we're already in a draft, default to the current draft filename
    if (currentReview?.is_draft && currentReview.id) {
      setDraftFilename(currentReview.id);
    } else {
      const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const defaultName = `${currentReview?.target_refset || 'REF'}_Advisor_${today}_v1`;
      setDraftFilename(defaultName);
    }
    setShowSaveModal(true);
  };

  const isOverwritingDraft = useMemo(() => {
    const trimmed = draftFilename.trim();
    if (!trimmed) return false;
    return reviewsList.some(r => r.is_draft && r.id.toLowerCase() === trimmed.toLowerCase());
  }, [draftFilename, reviewsList]);

  const confirmSaveDraft = async () => {
    if (!currentReview) return;
    const saveId = draftFilename.trim();
    if (!saveId) {
      showToast("Please enter a valid draft name.");
      return;
    }

    const inclusions = criteria.filter(c => !c.is_exclusion).map(c => ({
      concept_id: c.concept_id,
      term: c.term,
      include_self: c.include_self,
      attributes: c.attributes,
    }));
    const exclusions = criteria.filter(c => c.is_exclusion).map(c => ({
      concept_id: c.concept_id,
      term: c.term,
      include_self: c.include_self,
      attributes: c.attributes,
    }));

    const draftPayload = {
      draft_id: saveId,
      target_refset: currentReview.target_refset,
      snomed_release: currentReview.snomed_release,
      reviewer: CURRENT_USER,
      updated_at: new Date().toISOString(),
      notes: reviewerNotes,
      inclusions,
      exclusions,
      metrics: evalResult?.metrics,
      generated_ecl: evalResult?.generated_ecl,
    };

    try {
      await api.saveDraft(draftPayload);
      setShowSaveModal(false);
      showToast(`Draft saved: ${saveId}.json`);
      const items = await api.fetchReviews();
      setReviewsList(items);
      // Update selectedReviewId to the newly saved draft
      setSelectedReviewId(saveId);
    } catch (e) {
      console.error(e);
      showToast("Error saving draft to storage.");
    }
  };

  const confirmDeleteDraft = async () => {
    if (!currentReview || !currentReview.is_draft) return;
    const draftIdToDelete = selectedReviewId;
    const fallbackTarget = currentReview.target_refset;

    try {
      await api.deleteDraft(draftIdToDelete);
      setShowDeleteModal(false);
      showToast(`Deleted draft: ${draftIdToDelete}`);
      const items = await api.fetchReviews();
      setReviewsList(items);
      // Switch back to the baseline refset
      setSelectedReviewId(fallbackTarget);
    } catch (e) {
      console.error(e);
      showToast("Error deleting draft.");
    }
  };

  // Separate active inclusions and exclusions
  const activeInclusions = useMemo(() => criteria.filter(c => !c.is_exclusion), [criteria]);
  const activeExclusions = useMemo(() => criteria.filter(c => c.is_exclusion), [criteria]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#F3F4F6] text-gray-900 select-none overflow-hidden">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-20 right-6 z-[100] animate-toastIn">
          <div className="bg-gray-900 text-white px-5 py-2.5 rounded-xl shadow-2xl flex items-center gap-3 border border-gray-700">
            <i className="fas fa-check-circle text-green-400"></i>
            <span className="text-sm font-semibold tracking-wide">{toastMessage}</span>
          </div>
        </div>
      )}

      {/* Save Draft Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-gray-100 flex flex-col">
            <div className="flex items-center gap-4 mb-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isOverwritingDraft ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                <i className={`fas ${isOverwritingDraft ? 'fa-exclamation-triangle' : 'fa-save'} text-xl`}></i>
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-800">
                  {isOverwritingDraft ? 'Overwrite Review Draft' : 'Save Review Draft'}
                </h3>
                <p className="text-xs text-gray-500 font-medium">Saves versioned draft without altering baseline</p>
              </div>
            </div>

            {/* Overwrite warning banner */}
            {isOverwritingDraft && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-xs text-amber-900 animate-fadeIn">
                <i className="fas fa-exclamation-circle text-amber-600 mt-0.5 flex-shrink-0"></i>
                <div>
                  <strong className="block font-bold">Draft file already exists:</strong>
                  Saving will overwrite <code className="font-mono bg-amber-100/80 px-1 py-0.5 rounded text-[11px] font-bold">{draftFilename.trim()}.json</code> with your latest criteria and notes. Are you sure you want to proceed?
                </div>
              </div>
            )}

            <div className="space-y-4 mb-6">
              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1">Draft Filename</label>
                <input 
                  type="text"
                  value={draftFilename}
                  onChange={e => setDraftFilename(e.target.value)}
                  className="w-full border border-gray-200 p-2.5 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono bg-gray-50/50"
                  placeholder="e.g. AST_COD_Joe_v1"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1">Clinical Rationale / Notes</label>
                <textarea 
                  rows={3}
                  value={reviewerNotes}
                  onChange={e => setReviewerNotes(e.target.value)}
                  className="w-full border border-gray-200 p-2.5 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-xs text-gray-700 bg-gray-50/50"
                  placeholder="Document why criteria were modified..."
                />
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <button 
                onClick={() => setShowSaveModal(false)}
                className="px-4 py-2 text-xs font-bold text-gray-500 hover:text-gray-700 uppercase"
              >
                Cancel
              </button>
              <button 
                onClick={confirmSaveDraft}
                className={`px-5 py-2 text-xs font-bold text-white rounded-xl shadow-md transition-colors ${
                  isOverwritingDraft ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {isOverwritingDraft ? 'Overwrite & Save Draft' : 'Save Draft'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Draft Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-gray-100 flex flex-col">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-rose-50 text-rose-600 rounded-full flex items-center justify-center">
                <i className="fas fa-trash-alt text-xl"></i>
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-800">Delete Review Draft</h3>
                <p className="text-xs text-gray-500 font-medium">Permanent deletion confirmation</p>
              </div>
            </div>

            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-900 mb-6">
              <i className="fas fa-exclamation-triangle text-rose-600 mt-0.5 flex-shrink-0"></i>
              <div>
                Are you sure you want to permanently delete draft <code className="font-mono bg-rose-100 px-1 py-0.5 rounded font-bold text-[11px]">{selectedReviewId}.json</code>?
                <p className="mt-1 text-gray-600">This action cannot be undone. Workspace will revert to baseline refset <strong className="text-gray-800">{currentReview?.target_refset}</strong>.</p>
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <button 
                onClick={() => setShowDeleteModal(false)}
                className="px-4 py-2 text-xs font-bold text-gray-500 hover:text-gray-700 uppercase"
              >
                Cancel
              </button>
              <button 
                onClick={confirmDeleteDraft}
                className="px-5 py-2 text-xs font-bold bg-rose-600 text-white rounded-xl hover:bg-rose-700 shadow-md transition-colors"
              >
                Delete Draft
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Top Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex justify-between items-center z-50 flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-md shadow-blue-500/20">
            <i className="fas fa-stethoscope text-lg"></i>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-gray-800 leading-tight">SNOMED Refset Review Workspace</h1>
              <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                NHS Cohorts
              </span>
            </div>
            <p className="text-xs text-gray-500 font-medium">Clinical Governance &amp; Expression Constraint Language (ECL) Porting</p>
          </div>
        </div>

        {/* Refset & Draft Selector */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 px-3 py-1.5 rounded-xl">
            <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Target:</span>
            <select 
              value={selectedReviewId}
              onChange={e => setSelectedReviewId(e.target.value)}
              className="bg-transparent text-xs font-bold text-gray-800 outline-none cursor-pointer"
            >
              <optgroup label="Agent Baselines">
                {reviewsList.filter(r => !r.is_draft).map(r => (
                  <option key={r.id} value={r.id}>{r.target_refset}</option>
                ))}
              </optgroup>
              {reviewsList.some(r => r.is_draft) && (
                <optgroup label="Saved Drafts">
                  {reviewsList.filter(r => r.is_draft).map(r => (
                    <option key={r.id} value={r.id}>Draft: {r.id}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {/* User profile */}
          <div className="flex items-center gap-2.5 px-3 py-1.5 bg-gray-50 rounded-full border border-gray-200 shadow-sm">
            <div className="w-7 h-7 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs">
              <i className="fas fa-user-md"></i>
            </div>
            <span className="text-xs font-bold text-gray-700">{CURRENT_USER}</span>
          </div>

          {/* Action Buttons: Delete (draft only) & Save Draft */}
          <div className="flex items-center gap-2">
            {currentReview?.is_draft && (
              <button 
                type="button"
                onClick={() => setShowDeleteModal(true)}
                className="px-3.5 py-2 text-xs font-bold bg-rose-50 text-rose-600 border border-rose-200 rounded-xl hover:bg-rose-600 hover:text-white transition-colors shadow-2xs flex items-center gap-1.5"
                title="Delete this review draft"
              >
                <i className="fas fa-trash-alt text-xs"></i>
                <span>Delete Draft</span>
              </button>
            )}

            <button 
              type="button"
              onClick={handleOpenSaveModal}
              className="px-4 py-2 text-xs font-bold bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors shadow-sm flex items-center gap-2"
            >
              <i className="fas fa-save"></i>
              <span>Save Draft</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main 2-Panel Workspace Layout */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        
        {/* ========================================================= */}
        {/* LEFT PANEL: Clinical Review & Live Evaluated Impact (50%)  */}
        {/* ========================================================= */}
        <section className="w-1/2 bg-white border-r border-gray-200 flex flex-col min-h-0 overflow-hidden">
          
          {/* Top Section: Legacy Refset Strip (ABOVE SCORECARDS) + Scorecards */}
          <div className="p-4 border-b border-gray-200 bg-gray-50/70 flex-shrink-0">
            
            {/* 1. Legacy Refset Strip placed ABOVE scorecards */}
            {currentReview?.legacy_details ? (
              <div className="mb-3 bg-white rounded-xl px-4 py-2 flex items-center justify-between text-xs text-gray-600 border border-gray-200 shadow-sm">
                <span>
                  <strong className="text-gray-800">Legacy Refset:</strong> {currentReview.legacy_details.total_count} total codes
                </span>
                <span className="text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                  {currentReview.legacy_details.active_count} active targets analyzed
                </span>
                <span className="text-amber-700 font-bold bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
                  {currentReview.legacy_details.inactive_count} inactive in release
                </span>
              </div>
            ) : (
              <div className="mb-3 bg-white rounded-xl px-4 py-2 flex items-center justify-between text-xs text-gray-600 border border-gray-200">
                <span>
                  <strong className="text-gray-800">Target Cohort:</strong> {currentReview?.target_codes.length || 0} active codes
                </span>
                <span className="text-gray-500 font-medium">Release: {currentReview?.snomed_release || 'UK Monolith'}</span>
              </div>
            )}

            {/* Header info */}
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-gray-800 uppercase tracking-wider">Evaluation Scorecards</span>
                {isEvaluating && <span className="text-[10px] text-blue-600 animate-pulse font-semibold">(Recalculating...)</span>}
              </div>
              <div className="text-[11px] font-medium text-gray-500">
                SNOMED CT: <span className="font-semibold text-gray-700">{currentReview?.snomed_release || 'UK Monolith'}</span>
              </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-6 gap-2">
              <div className="bg-white border border-gray-200 rounded-xl p-2.5 flex flex-col text-center shadow-sm">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Coverage</span>
                <span className="text-lg font-black text-blue-600 leading-tight">
                  {evalResult ? `${(evalResult.metrics.coverage * 100).toFixed(1)}%` : '--'}
                </span>
                <span className="text-[9px] text-gray-400 mt-0.5">Primary Target</span>
              </div>

              <div className="bg-white border border-gray-200 rounded-xl p-2.5 flex flex-col text-center shadow-sm">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Purity</span>
                <span className="text-lg font-black text-purple-600 leading-tight">
                  {evalResult ? `${(evalResult.metrics.purity * 100).toFixed(1)}%` : '--'}
                </span>
                <span className="text-[9px] text-gray-400 mt-0.5">Precision</span>
              </div>

              <div className="bg-white border border-gray-200 rounded-xl p-2.5 flex flex-col text-center shadow-sm">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Positives</span>
                <span className="text-lg font-black text-gray-800 leading-tight">
                  {evalResult ? evalResult.metrics.positives_count : '--'}
                </span>
                <span className="text-[9px] text-gray-400 mt-0.5">Total Captured</span>
              </div>

              <div className="bg-white border border-gray-200 rounded-xl p-2.5 flex flex-col text-center shadow-sm">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">TP</span>
                <span className="text-lg font-black text-emerald-600 leading-tight">
                  {evalResult ? evalResult.metrics.true_positives_count : '--'}
                </span>
                <span className="text-[9px] text-gray-400 mt-0.5">True Cohort</span>
              </div>

              <div className="bg-white border border-gray-200 rounded-xl p-2.5 flex flex-col text-center shadow-sm">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">FP</span>
                <span className="text-lg font-black text-amber-600 leading-tight">
                  {evalResult ? evalResult.metrics.false_positives_count : '--'}
                </span>
                <span className="text-[9px] text-gray-400 mt-0.5">Extra / Noise</span>
              </div>

              <div className="bg-white border border-gray-200 rounded-xl p-2.5 flex flex-col text-center shadow-sm">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">FN</span>
                <span className="text-lg font-black text-rose-600 leading-tight">
                  {evalResult ? evalResult.metrics.false_negatives_count : '--'}
                </span>
                <span className="text-[9px] text-gray-400 mt-0.5">Uncaptured</span>
              </div>
            </div>
          </div>

          {/* Left Panel Tabs */}
          <div className="flex border-b border-gray-200 bg-white px-3 pt-2 gap-3 overflow-x-auto flex-shrink-0">
            <button
              onClick={() => setLeftTab('codes')}
              className={`pb-2 text-xs font-bold border-b-2 whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                leftTab === 'codes' ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              <i className="fas fa-list-ol text-[11px]"></i>
              Codes
            </button>

            <button
              onClick={() => setLeftTab('recommendations')}
              className={`pb-2 text-xs font-bold border-b-2 whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                leftTab === 'recommendations' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              <i className="fas fa-lightbulb text-[11px]"></i>
              Recommendations
            </button>

            <button
              onClick={() => setLeftTab('details')}
              className={`pb-2 text-xs font-bold border-b-2 whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                leftTab === 'details' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              <i className="fas fa-file-alt text-[11px]"></i>
              Details
            </button>

            <button
              onClick={() => setLeftTab('notes')}
              className={`pb-2 text-xs font-bold border-b-2 whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                leftTab === 'notes' ? 'border-purple-600 text-purple-600' : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              <i className="fas fa-sticky-note text-[11px]"></i>
              Reviewer Notes
              {reviewerNotes.trim() && (
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
              )}
            </button>
          </div>

          {/* Left Panel Content */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-white flex flex-col">
            {isLoadingReview ? (
              <div className="flex items-center justify-center h-full text-gray-400 text-xs">
                <i className="fas fa-circle-notch fa-spin mr-2"></i> Loading review data...
              </div>
            ) : leftTab === 'codes' ? (
              <div className="flex flex-col h-full space-y-3">
                {/* Exclusive Filter Pills Toolbar */}
                <div className="flex items-center gap-1.5 p-1 bg-gray-100/80 rounded-xl flex-wrap flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setCodeFilter('positives')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                      codeFilter === 'positives'
                        ? 'bg-white text-gray-900 shadow-xs'
                        : 'text-gray-500 hover:text-gray-800'
                    }`}
                  >
                    All Positives ({evalResult?.metrics.positives_count || 0})
                  </button>

                  <button
                    type="button"
                    onClick={() => setCodeFilter('tp')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                      codeFilter === 'tp'
                        ? 'bg-emerald-600 text-white shadow-xs'
                        : 'text-emerald-700 hover:bg-emerald-50'
                    }`}
                  >
                    True Positives ({evalResult?.metrics.true_positives_count || 0})
                  </button>

                  <button
                    type="button"
                    onClick={() => setCodeFilter('fp')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                      codeFilter === 'fp'
                        ? 'bg-amber-500 text-white shadow-xs'
                        : 'text-amber-700 hover:bg-amber-50'
                    }`}
                  >
                    False Positives ({evalResult?.metrics.false_positives_count || 0})
                  </button>

                  <button
                    type="button"
                    onClick={() => setCodeFilter('fn')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                      codeFilter === 'fn'
                        ? 'bg-rose-600 text-white shadow-xs'
                        : 'text-rose-700 hover:bg-rose-50'
                    }`}
                  >
                    False Negatives ({evalResult?.metrics.false_negatives_count || 0})
                  </button>

                  <button
                    type="button"
                    onClick={() => setCodeFilter('inactive')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                      codeFilter === 'inactive'
                        ? 'bg-gray-700 text-white shadow-xs'
                        : 'text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    Inactive Codes ({currentReview?.legacy_details?.inactive_count || 0})
                  </button>
                </div>

                {/* Filter Descriptions & Codes List */}
                <div className="flex-1 overflow-y-auto pr-1 space-y-2">
                  {codeFilter === 'positives' && (
                    <>
                      <p className="text-xs text-gray-500 mb-2">
                        All {evalResult?.positives.length || 0} SNOMED concept codes matched by the active inclusion and exclusion criteria.
                      </p>
                      {evalResult?.positives.map(item => (
                        <div key={item.id} className="p-2.5 bg-gray-50 border border-gray-200 rounded-xl flex items-start justify-between gap-3 hover:bg-gray-100/60 transition-colors">
                          <div>
                            <span className="font-mono text-xs font-bold text-gray-800">{item.id}</span>
                            <p className="text-xs font-semibold text-gray-700 mt-0.5">{item.term}</p>
                          </div>
                          <span className="text-[10px] bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex-shrink-0">
                            Positive
                          </span>
                        </div>
                      ))}
                    </>
                  )}

                  {codeFilter === 'tp' && (
                    <>
                      <p className="text-xs text-gray-500 mb-2">
                        True Positives: {evalResult?.true_positives.length || 0} active codes from the legacy cohort successfully captured by the criteria.
                      </p>
                      {evalResult?.true_positives.map(item => (
                        <div key={item.id} className="p-2.5 bg-emerald-50/50 border border-emerald-200/60 rounded-xl flex items-start justify-between gap-3 hover:bg-emerald-50 transition-colors">
                          <div>
                            <span className="font-mono text-xs font-bold text-emerald-900">{item.id}</span>
                            <p className="text-xs font-semibold text-gray-800 mt-0.5">{item.term}</p>
                          </div>
                          <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex-shrink-0">
                            True Positive
                          </span>
                        </div>
                      ))}
                    </>
                  )}

                  {codeFilter === 'fp' && (
                    <>
                      <p className="text-xs text-gray-500 mb-2">
                        False Positives: {evalResult?.false_positives.length || 0} codes intercepted by criteria but not in the legacy refset. Review to distinguish accidental omissions from noise.
                      </p>
                      {evalResult?.false_positives.map(item => (
                        <div key={item.id} className="p-2.5 bg-amber-50/50 border border-amber-200/60 rounded-xl flex items-start justify-between gap-3 hover:bg-amber-50 transition-colors">
                          <div>
                            <span className="font-mono text-xs font-bold text-amber-900">{item.id}</span>
                            <p className="text-xs font-semibold text-gray-800 mt-0.5">{item.term}</p>
                          </div>
                          <span className="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex-shrink-0">
                            False Positive
                          </span>
                        </div>
                      ))}
                    </>
                  )}

                  {codeFilter === 'fn' && (
                    <>
                      <p className="text-xs text-gray-500 mb-2">
                        False Negatives: {evalResult?.false_negatives.length || 0} codes in legacy refset omitted by criteria. Review boundary justifications to confirm omission validity.
                      </p>
                      {evalResult?.false_negatives.map(item => (
                        <div key={item.id} className="p-2.5 bg-rose-50/50 border border-rose-200/60 rounded-xl flex items-start justify-between gap-3 hover:bg-rose-50 transition-colors">
                          <div>
                            <span className="font-mono text-xs font-bold text-rose-900">{item.id}</span>
                            <p className="text-xs font-semibold text-gray-800 mt-0.5">{item.term}</p>
                          </div>
                          <span className="text-[10px] bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex-shrink-0">
                            False Negative
                          </span>
                        </div>
                      ))}
                    </>
                  )}

                  {codeFilter === 'inactive' && (
                    <>
                      <p className="text-xs text-gray-500 mb-2">
                        Inactive Codes: {currentReview?.legacy_details?.inactive_count || 0} codes from the historical refset that are no longer active in this SNOMED release.
                      </p>
                      {(currentReview?.legacy_details?.inactive_codes || []).map(code => (
                        <div key={code} className="p-2.5 bg-gray-50 border border-gray-200 rounded-xl flex items-start justify-between gap-3">
                          <div>
                            <span className="font-mono text-xs font-bold text-gray-700">{code}</span>
                            <p className="text-xs text-gray-500 mt-0.5">Deprecated / Inactive concept in release</p>
                          </div>
                          <span className="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex-shrink-0">
                            Inactive
                          </span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            ) : leftTab === 'recommendations' ? (
              <div className="prose prose-sm max-w-none text-gray-800 text-xs leading-relaxed p-2">
                {currentReview?.recommendations ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ node, ...props }) => <h1 className="text-base font-bold text-gray-900 mt-4 mb-2 border-b pb-1" {...props} />,
                      h2: ({ node, ...props }) => <h2 className="text-sm font-bold text-gray-900 mt-3 mb-1.5" {...props} />,
                      h3: ({ node, ...props }) => <h3 className="text-xs font-bold text-gray-800 mt-2.5 mb-1" {...props} />,
                      p: ({ node, ...props }) => <p className="mb-2 leading-relaxed text-gray-700" {...props} />,
                      ul: ({ node, ...props }) => <ul className="list-disc list-inside mb-2 space-y-1 text-gray-700 pl-1" {...props} />,
                      ol: ({ node, ...props }) => <ol className="list-decimal list-inside mb-2 space-y-1 text-gray-700 pl-1" {...props} />,
                      li: ({ node, ...props }) => <li className="text-xs leading-relaxed" {...props} />,
                      code: ({ node, className, children, ...props }) => (
                        <code className="bg-gray-100 text-gray-800 font-mono text-[11px] px-1 py-0.5 rounded border border-gray-200" {...props}>
                          {children}
                        </code>
                      ),
                      blockquote: ({ node, ...props }) => (
                        <blockquote className="border-l-4 border-blue-400 pl-3 py-1 my-2 bg-blue-50/50 text-gray-700 italic text-xs rounded-r" {...props} />
                      ),
                      table: ({ node, ...props }) => (
                        <div className="overflow-x-auto my-2">
                          <table className="min-w-full divide-y divide-gray-200 text-xs border border-gray-200" {...props} />
                        </div>
                      ),
                      th: ({ node, ...props }) => <th className="px-2 py-1.5 bg-gray-50 text-left font-bold text-gray-700 border-b" {...props} />,
                      td: ({ node, ...props }) => <td className="px-2 py-1 border-b border-gray-100" {...props} />
                    }}
                  >
                    {currentReview.recommendations}
                  </ReactMarkdown>
                ) : (
                  <div className="text-gray-400 italic">No recommendations found in this dataset.</div>
                )}
              </div>
            ) : leftTab === 'details' ? (
              <div className="prose prose-sm max-w-none text-gray-800 text-xs leading-relaxed p-2">
                {currentReview?.markdown_report ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ node, ...props }) => <h1 className="text-base font-bold text-gray-900 mt-4 mb-2 border-b pb-1" {...props} />,
                      h2: ({ node, ...props }) => <h2 className="text-sm font-bold text-gray-900 mt-3 mb-1.5" {...props} />,
                      h3: ({ node, ...props }) => <h3 className="text-xs font-bold text-gray-800 mt-2.5 mb-1" {...props} />,
                      p: ({ node, ...props }) => <p className="mb-2 leading-relaxed text-gray-700" {...props} />,
                      ul: ({ node, ...props }) => <ul className="list-disc list-inside mb-2 space-y-1 text-gray-700 pl-1" {...props} />,
                      ol: ({ node, ...props }) => <ol className="list-decimal list-inside mb-2 space-y-1 text-gray-700 pl-1" {...props} />,
                      li: ({ node, ...props }) => <li className="text-xs leading-relaxed" {...props} />,
                      code: ({ node, className, children, ...props }) => (
                        <code className="bg-gray-100 text-gray-800 font-mono text-[11px] px-1 py-0.5 rounded border border-gray-200" {...props}>
                          {children}
                        </code>
                      ),
                      blockquote: ({ node, ...props }) => (
                        <blockquote className="border-l-4 border-blue-400 pl-3 py-1 my-2 bg-blue-50/50 text-gray-700 italic text-xs rounded-r" {...props} />
                      ),
                      table: ({ node, ...props }) => (
                        <div className="overflow-x-auto my-2">
                          <table className="min-w-full divide-y divide-gray-200 text-xs border border-gray-200" {...props} />
                        </div>
                      ),
                      th: ({ node, ...props }) => <th className="px-2 py-1.5 bg-gray-50 text-left font-bold text-gray-700 border-b" {...props} />,
                      td: ({ node, ...props }) => <td className="px-2 py-1 border-b border-gray-100" {...props} />
                    }}
                  >
                    {currentReview.markdown_report}
                  </ReactMarkdown>
                ) : (
                  <div className="text-gray-400 italic">No details report available for this dataset.</div>
                )}
              </div>
            ) : (
              /* Reviewer Notes Tab */
              <div className="flex flex-col h-full space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-gray-100 flex-shrink-0">
                  <div>
                    <h3 className="text-sm font-bold text-gray-800">Reviewer Notes & Decision Rationale</h3>
                    <p className="text-[11px] text-gray-500">
                      Document clinical rationale, refset scope adjustments, or reason for inclusion/exclusion criteria modifications.
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="text-[11px] font-mono text-gray-400">
                      {reviewerNotes.length} characters
                    </span>
                  </div>
                </div>

                <div className="flex-1 flex flex-col min-h-0">
                  <textarea
                    value={reviewerNotes}
                    onChange={e => setReviewerNotes(e.target.value)}
                    placeholder="Enter clinical rationale, justification for edge cases, and notes on cohort definition revisions here... When you click 'Save Draft' in the top header, these notes are persisted."
                    className="flex-1 w-full p-3.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none text-xs text-gray-800 font-sans leading-relaxed resize-none bg-gray-50/40"
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ========================================================= */}
        {/* RIGHT PANEL: Interactive Criteria Builder (50%)           */}
        {/* ========================================================= */}
        <section className="w-1/2 bg-[#F9FAFB] flex flex-col min-h-0 overflow-hidden">
          
          {/* 1. ACTIVE CLINICAL CRITERIA (TOPMOST CONTAINER) */}
          <div className="p-4 bg-white border-b border-gray-200 shadow-sm flex-shrink-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-gray-800 uppercase tracking-wider flex items-center gap-1.5">
                <i className="fas fa-layer-group text-blue-600"></i>
                Active Clinical Criteria ({criteria.length})
              </span>
              <span className="text-[10px] text-gray-400">Click any criterion to populate editor</span>
            </div>

            {criteria.length === 0 ? (
              <div className="text-xs text-gray-400 italic p-3 text-center border border-dashed border-gray-200 rounded-xl">
                No active criteria. Select concepts below to build inclusions/exclusions.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 max-h-36 overflow-y-auto pr-1">
                {/* Column 1: Inclusions */}
                <div className="bg-blue-50/40 border border-blue-100 rounded-xl p-2 flex flex-col gap-1.5">
                  <span className="text-[10px] font-bold text-blue-800 uppercase tracking-wider flex items-center gap-1">
                    <i className="fas fa-plus-circle text-blue-600"></i>
                    Inclusion Criteria ({activeInclusions.length})
                  </span>
                  {activeInclusions.length === 0 ? (
                    <span className="text-[11px] text-gray-400 italic">None</span>
                  ) : (
                    activeInclusions.map(crit => {
                      const attrStr = crit.attributes.length > 0
                        ? ': ' + crit.attributes.map(a => `${a.attributeName || a.type_id} = ${(a.valueTerms || a.value_ids).join(', ')}`).join(', ')
                        : '';
                      const fullExpression = `<< ${crit.concept_id} |${crit.term}|${attrStr}`;
                      return (
                        <div 
                          key={crit.id}
                          onClick={() => handleSelectExistingCriteria(crit)}
                          title={fullExpression}
                          className="group relative flex items-center justify-between p-1.5 bg-white border border-blue-200 rounded-lg text-xs hover:border-blue-400 cursor-pointer transition-colors shadow-2xs"
                        >
                          <div className="truncate mr-1 min-w-0">
                            <span className="font-mono font-bold text-blue-700">&lt;&lt; {crit.concept_id}</span>
                            <span className="text-gray-700 ml-1 truncate">|{crit.term}|</span>
                            {crit.attributes.length > 0 && (
                              <span className="ml-1 bg-blue-100 text-blue-800 text-[9px] px-1 py-0.2 rounded font-bold whitespace-nowrap">
                                :{crit.attributes.length} attrs
                              </span>
                            )}
                          </div>
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleRemoveRule(crit.id); }}
                            className="text-gray-300 hover:text-red-600 p-0.5 flex-shrink-0"
                            title="Remove rule"
                          >
                            <i className="fas fa-times text-xs"></i>
                          </button>

                          {/* Hover Tooltip Popup */}
                          <div className="pointer-events-none absolute left-0 bottom-full mb-1 z-50 hidden group-hover:block w-max max-w-sm bg-gray-900 text-white text-[11px] rounded-lg p-2 shadow-xl border border-gray-700">
                            <div className="font-mono text-blue-300 font-bold mb-0.5">&lt;&lt; {crit.concept_id} |{crit.term}|</div>
                            {crit.attributes.length > 0 && (
                              <div className="text-gray-300 border-t border-gray-700 pt-1 mt-1 space-y-0.5 text-[10px]">
                                {crit.attributes.map((a, i) => (
                                  <div key={i}>
                                    <span className="text-gray-400">{a.attributeName || `Attr ${a.type_id}`}:</span>{' '}
                                    <span className="text-amber-300">{(a.valueTerms || a.value_ids).join(', ')}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Column 2: Exclusions */}
                <div className="bg-rose-50/40 border border-rose-100 rounded-xl p-2 flex flex-col gap-1.5">
                  <span className="text-[10px] font-bold text-rose-800 uppercase tracking-wider flex items-center gap-1">
                    <i className="fas fa-minus-circle text-rose-600"></i>
                    Exclusion Criteria ({activeExclusions.length})
                  </span>
                  {activeExclusions.length === 0 ? (
                    <span className="text-[11px] text-gray-400 italic">None</span>
                  ) : (
                    activeExclusions.map(crit => {
                      const attrStr = crit.attributes.length > 0
                        ? ': ' + crit.attributes.map(a => `${a.attributeName || a.type_id} = ${(a.valueTerms || a.value_ids).join(', ')}`).join(', ')
                        : '';
                      const fullExpression = `MINUS << ${crit.concept_id} |${crit.term}|${attrStr}`;
                      return (
                        <div 
                          key={crit.id}
                          onClick={() => handleSelectExistingCriteria(crit)}
                          title={fullExpression}
                          className="group relative flex items-center justify-between p-1.5 bg-white border border-rose-200 rounded-lg text-xs hover:border-rose-400 cursor-pointer transition-colors shadow-2xs"
                        >
                          <div className="truncate mr-1 min-w-0">
                            <span className="font-mono font-bold text-rose-700">MINUS &lt;&lt; {crit.concept_id}</span>
                            <span className="text-gray-700 ml-1 truncate">|{crit.term}|</span>
                            {crit.attributes.length > 0 && (
                              <span className="ml-1 bg-rose-100 text-rose-800 text-[9px] px-1 py-0.2 rounded font-bold whitespace-nowrap">
                                :{crit.attributes.length} attrs
                              </span>
                            )}
                          </div>
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleRemoveRule(crit.id); }}
                            className="text-gray-300 hover:text-red-600 p-0.5 flex-shrink-0"
                            title="Remove rule"
                          >
                            <i className="fas fa-times text-xs"></i>
                          </button>

                          {/* Hover Tooltip Popup */}
                          <div className="pointer-events-none absolute right-0 bottom-full mb-1 z-50 hidden group-hover:block w-max max-w-sm bg-gray-900 text-white text-[11px] rounded-lg p-2 shadow-xl border border-gray-700">
                            <div className="font-mono text-rose-300 font-bold mb-0.5">MINUS &lt;&lt; {crit.concept_id} |{crit.term}|</div>
                            {crit.attributes.length > 0 && (
                              <div className="text-gray-300 border-t border-gray-700 pt-1 mt-1 space-y-0.5 text-[10px]">
                                {crit.attributes.map((a, i) => (
                                  <div key={i}>
                                    <span className="text-gray-400">{a.attributeName || `Attr ${a.type_id}`}:</span>{' '}
                                    <span className="text-amber-300">{(a.valueTerms || a.value_ids).join(', ')}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 2. ACTION BUTTONS BOX (LENGTHWISE ACROSS PANEL) */}
          <div className="p-3 bg-white border-b border-gray-200 flex-shrink-0 shadow-2xs">
            <div className="grid grid-cols-2 gap-3">
              <button
                disabled={!selectedRoot}
                onClick={() => handleAddRule(false)}
                className={`py-2.5 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 shadow-sm transition-all ${
                  selectedRoot 
                    ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20 cursor-pointer' 
                    : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed'
                }`}
              >
                <i className="fas fa-plus"></i>
                <span>Add as Inclusion criteria</span>
              </button>

              <button
                disabled={!selectedRoot}
                onClick={() => handleAddRule(true)}
                className={`py-2.5 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 shadow-sm transition-all ${
                  selectedRoot 
                    ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-500/20 cursor-pointer' 
                    : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed'
                }`}
              >
                <i className="fas fa-minus"></i>
                <span>Add as Exclusion criteria</span>
              </button>
            </div>
            {!selectedRoot && (
              <p className="text-[10px] text-gray-400 text-center mt-1.5 italic">
                Select a root concept below to enable criteria addition
              </p>
            )}
          </div>

          {/* BUILDER WORKSPACE (FULLY SCROLLABLE) */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
            
            {/* 3. "1. Select domain" */}
            <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm flex-shrink-0">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-2">1. Select Domain</span>
              <div className="grid grid-cols-4 gap-2">
                {Object.values(Door).map(door => (
                  <button
                    key={door}
                    onClick={() => {
                      setActiveDoor(door);
                      setActiveSubDomain(DOORS_CONFIG[door][0].id);
                    }}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      activeDoor === door 
                        ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-600/20' 
                        : 'bg-gray-50 hover:bg-gray-100 text-gray-700 border-gray-200'
                    }`}
                  >
                    <span className="block text-xs font-bold leading-tight">{door}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 4. "2. Select root" (RENAMED FROM SEARCH SNOMED HIERARCHY) */}
            <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm flex-shrink-0">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-2">2. Select Root</span>

              {!selectedRoot ? (
                <div>
                  <div className="flex gap-2">
                    <input 
                      type="text"
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleSearch()}
                      className="flex-1 border border-gray-200 px-3 py-2 rounded-xl text-xs outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50/50"
                      placeholder="e.g. Asthma, Pregnancy, Hysterectomy, or concept ID..."
                    />
                    <button
                      onClick={handleSearch}
                      className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700 transition-colors shadow-sm"
                    >
                      {isSearching ? <i className="fas fa-circle-notch fa-spin"></i> : 'SEARCH'}
                    </button>
                  </div>

                  {/* Search Results (collapses once root is selected, sorted alphabetically) */}
                  {searchResults.length > 0 && (
                    <div className="mt-3 max-h-48 overflow-y-auto border border-gray-100 rounded-xl divide-y divide-gray-100">
                      {searchResults.map(c => (
                        <div 
                          key={c.id} 
                          onClick={() => handleSelectRoot(c)}
                          className="p-2.5 flex items-center justify-between cursor-pointer hover:bg-blue-50 transition-colors"
                        >
                          <div>
                            <span className="text-xs font-bold text-gray-800">{c.term}</span>
                            <span className="font-mono text-[11px] text-gray-400 ml-2">{c.id}</span>
                          </div>
                          <span className="text-[10px] bg-gray-100 text-gray-600 font-semibold px-2 py-0.5 rounded-full">
                            {c.descendant_count || 0} descendants
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {hasSearched && !isSearching && searchResults.length === 0 && (
                    <p className="text-xs text-gray-400 italic text-center mt-3">No matching concepts found.</p>
                  )}
                </div>
              ) : (
                /* Selected Root Banner matching SNOMED_refset_builder */
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center justify-between animate-fadeIn">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center text-sm shadow-sm">
                      <i className="fas fa-tree"></i>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-blue-600 font-bold uppercase tracking-wider">Selected Root:</span>
                        <span className="text-sm font-bold text-blue-900">{selectedRoot.term}</span>
                        <span className="text-xs font-mono text-blue-500">({selectedRoot.id})</span>
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={handleChangeRoot}
                    className="bg-white text-blue-600 hover:bg-blue-600 hover:text-white px-3 py-1.5 rounded-lg border border-blue-200 text-xs font-bold transition-all shadow-sm uppercase tracking-wide"
                  >
                    Change
                  </button>
                </div>
              )}
            </div>

            {/* 5. "3. Filter by attributes" (COLLAPSIBLE / FOLDABLE) */}
            <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm flex flex-col gap-2 flex-shrink-0">
              <div 
                onClick={() => setIsAttributesOpen(prev => !prev)}
                className="flex items-center justify-between cursor-pointer select-none group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest group-hover:text-gray-800 transition-colors flex items-center gap-1.5">
                    <i className={`fas fa-chevron-${isAttributesOpen ? 'down' : 'right'} text-gray-400 group-hover:text-blue-600 text-[10px] transition-transform`}></i>
                    3. Filter by Attributes
                  </span>
                  {selectedRoot && attributes.length > 0 && (
                    <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-semibold">
                      {attributes.reduce((sum, a) => sum + a.options.filter(o => o.checked).length, 0) > 0 ? (
                        <span className="text-blue-600 font-bold">
                          {attributes.reduce((sum, a) => sum + a.options.filter(o => o.checked).length, 0)} active filter{attributes.reduce((sum, a) => sum + a.options.filter(o => o.checked).length, 0) > 1 ? 's' : ''}
                        </span>
                      ) : (
                        `${attributes.length} available`
                      )}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-400">
                    {isAttributesOpen ? 'Click to fold' : 'Click to expand'}
                  </span>
                </div>
              </div>

              {isAttributesOpen && (
                <div className="pt-2 border-t border-gray-100 animate-fadeIn">
                  {!selectedRoot ? (
                    <div className="text-xs text-gray-400 text-center py-4 italic bg-gray-50/70 rounded-xl border border-dashed border-gray-200">
                      Select a root concept above to view and filter by attributes.
                    </div>
                  ) : isLoadingAttrs ? (
                    <div className="text-xs text-gray-400 text-center py-4">
                      <i className="fas fa-circle-notch fa-spin mr-2"></i> Introspecting clinical attributes across descendants...
                    </div>
                  ) : attributes.length === 0 ? (
                    <div className="text-xs text-gray-400 text-center py-3 italic bg-gray-50 rounded-xl">
                      No specific semantic attributes available on this concept branch.
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
                      {attributes.map((attr, aIdx) => (
                        <div key={attr.attributeId} className="border border-gray-100 rounded-xl p-2.5 bg-gray-50/50">
                          <span className="text-xs font-bold text-gray-700 block mb-1.5">
                            {attr.name}
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {attr.options.map((opt, oIdx) => (
                              <button
                                key={opt.valueId}
                                type="button"
                                onClick={() => handleToggleAttributeOption(aIdx, oIdx)}
                                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs cursor-pointer transition-colors ${
                                  opt.checked ? 'bg-blue-600 text-white border-blue-600 shadow-sm' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-100'
                                }`}
                              >
                                <span className="font-medium text-[11px]">{opt.label}</span>
                                <span className={`text-[10px] px-1 rounded font-bold ${opt.checked ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-500'}`}>
                                  {opt.count}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 6. "SNOMED CODES SELECTED" (ALWAYS VISIBLE, MATCHING LEFT PANEL FORMAT, ALPHABETICAL) */}
            <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm flex flex-col gap-2 flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-gray-800 uppercase tracking-wider">
                    Snomed Codes Selected ({selectedCodesTotal})
                  </span>
                  {isLoadingSelectedCodes && (
                    <span className="text-[10px] text-blue-600 animate-pulse font-medium">Filtering...</span>
                  )}
                </div>
                <span className="text-[11px] text-gray-400">Alphabetical order</span>
              </div>

              {!selectedRoot ? (
                <div className="text-xs text-gray-400 text-center py-4 italic bg-gray-50/70 rounded-xl border border-dashed border-gray-200">
                  Select a root concept above to view selected codes.
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {selectedCodes.length === 0 ? (
                    <div className="p-4 text-center text-xs text-gray-400 italic bg-gray-50 rounded-xl">
                      {isLoadingSelectedCodes ? 'Loading codes...' : 'No codes match the selected attribute constraints.'}
                    </div>
                  ) : (
                    selectedCodes.map(code => (
                      <div 
                        key={code.id} 
                        className="p-2.5 bg-gray-50 border border-gray-200 rounded-xl flex items-start justify-between gap-3 hover:bg-gray-100/60 transition-colors"
                      >
                        <div>
                          <span className="font-mono text-xs font-bold text-gray-800">{code.id}</span>
                          <p className="text-xs font-semibold text-gray-700 mt-0.5">{code.term}</p>
                        </div>
                        <span className="text-[10px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex-shrink-0">
                          Selected
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

          </div>
        </section>

      </div>
    </div>
  );
}
