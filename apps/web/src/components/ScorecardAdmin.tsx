"use client";

import { GripVertical, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface EditableCriterion {
  label: string;
  description: string;
  weight: number;
  required: boolean;
}

interface EditableCategory {
  name: string;
  criteria: EditableCriterion[];
}

export function ScorecardAdmin({
  templateId,
  initialName,
  initialVersion,
  initialCategories,
}: {
  templateId: string | null;
  initialName: string;
  initialVersion: number;
  initialCategories: EditableCategory[];
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName || "Call Quality");
  const [categories, setCategories] = useState<EditableCategory[]>(
    initialCategories.length ? initialCategories : [{
      name: "Call quality",
      criteria: [{
        label: "Clear communication",
        description: "",
        weight: 1,
        required: true,
      }],
    }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function updateCategory(index: number, patch: Partial<EditableCategory>) {
    setCategories((current) => current.map((category, categoryIndex) => (
      categoryIndex === index ? { ...category, ...patch } : category
    )));
  }

  function updateCriterion(
    categoryIndex: number,
    criterionIndex: number,
    patch: Partial<EditableCriterion>,
  ) {
    setCategories((current) => current.map((category, currentCategoryIndex) => (
      currentCategoryIndex !== categoryIndex
        ? category
        : {
          ...category,
          criteria: category.criteria.map((criterion, currentCriterionIndex) => (
            currentCriterionIndex === criterionIndex ? { ...criterion, ...patch } : criterion
          )),
        }
    )));
  }

  function addCriterion(categoryIndex: number) {
    updateCategory(categoryIndex, {
      criteria: [
        ...categories[categoryIndex]!.criteria,
        { label: "", description: "", weight: 1, required: true },
      ],
    });
  }

  function removeCriterion(categoryIndex: number, criterionIndex: number) {
    updateCategory(categoryIndex, {
      criteria: categories[categoryIndex]!.criteria.filter((_, index) => index !== criterionIndex),
    });
  }

  async function publish() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/scorecards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, name, categories }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Scorecard could not be published");
      router.refresh();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Scorecard could not be published");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="scorecard-admin">
      <section className="admin-section">
        <div className="section-heading">
          <div>
            <h2>Template</h2>
            <p>
              {initialVersion
                ? `Published version ${initialVersion}. Saving creates version ${initialVersion + 1}.`
                : "Publish the first immutable version for this workspace."}
            </p>
          </div>
        </div>
        <div className="field">
          <label htmlFor="scorecard-name">Scorecard name</label>
          <input id="scorecard-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
      </section>

      {categories.map((category, categoryIndex) => (
        <section className="scorecard-builder-category" key={categoryIndex}>
          <div className="builder-category-heading">
            <GripVertical size={16} />
            <input
              value={category.name}
              onChange={(event) => updateCategory(categoryIndex, { name: event.target.value })}
              aria-label={`Category ${categoryIndex + 1} name`}
              placeholder="Category name"
            />
            <button
              className="icon-button"
              title="Remove category"
              aria-label="Remove category"
              disabled={categories.length === 1}
              onClick={() => setCategories((current) => current.filter((_, index) => index !== categoryIndex))}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <div className="criteria-builder">
            {category.criteria.map((criterion, criterionIndex) => (
              <div className="criterion-builder-row" key={criterionIndex}>
                <span className="mono">{criterionIndex + 1}</span>
                <div>
                  <input
                    value={criterion.label}
                    onChange={(event) => updateCriterion(categoryIndex, criterionIndex, { label: event.target.value })}
                    placeholder="Criterion"
                    aria-label={`Criterion ${criterionIndex + 1}`}
                  />
                  <input
                    value={criterion.description}
                    onChange={(event) => updateCriterion(categoryIndex, criterionIndex, { description: event.target.value })}
                    placeholder="Optional scoring guidance"
                    aria-label={`Guidance for criterion ${criterionIndex + 1}`}
                  />
                </div>
                <label className="weight-field">
                  <span>Weight</span>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={criterion.weight}
                    onChange={(event) => updateCriterion(categoryIndex, criterionIndex, {
                      weight: Math.max(1, Number(event.target.value) || 1),
                    })}
                  />
                </label>
                <button
                  className="icon-button"
                  title="Remove criterion"
                  aria-label="Remove criterion"
                  disabled={category.criteria.length === 1}
                  onClick={() => removeCriterion(categoryIndex, criterionIndex)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
          <button className="button button-quiet" onClick={() => addCriterion(categoryIndex)}>
            <Plus size={14} /> Add criterion
          </button>
        </section>
      ))}

      <div className="scorecard-builder-actions">
        <button
          className="button button-secondary"
          onClick={() => setCategories((current) => [
            ...current,
            {
              name: "New category",
              criteria: [{ label: "", description: "", weight: 1, required: true }],
            },
          ])}
        >
          <Plus size={15} /> Add category
        </button>
        <button className="button button-primary" onClick={() => void publish()} disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
          Publish version
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
