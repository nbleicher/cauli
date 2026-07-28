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

interface PublishedVersion {
  id: string;
  version: number;
  name: string;
}

interface ComparisonSet {
  id: string;
  versionIds: string[];
}

export function ScorecardAdmin({
  templateId,
  initialName,
  initialVersion,
  initialCategories,
  publishedVersions,
  comparisonSets,
}: {
  templateId: string | null;
  initialName: string;
  initialVersion: number;
  initialCategories: EditableCategory[];
  publishedVersions: PublishedVersion[];
  comparisonSets: ComparisonSet[];
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName || "Call Quality");
  const [categories, setCategories] = useState<EditableCategory[]>(
    initialCategories.length
      ? initialCategories
      : [
          {
            name: "Call quality",
            criteria: [
              {
                label: "Clear communication",
                description: "",
                weight: 1,
                required: true,
              },
            ],
          },
        ]
  );
  const [saving, setSaving] = useState(false);
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);
  const [savingComparability, setSavingComparability] = useState(false);
  const [error, setError] = useState("");

  function updateCategory(index: number, patch: Partial<EditableCategory>) {
    setCategories((current) =>
      current.map((category, categoryIndex) =>
        categoryIndex === index ? { ...category, ...patch } : category
      )
    );
  }

  function updateCriterion(
    categoryIndex: number,
    criterionIndex: number,
    patch: Partial<EditableCriterion>
  ) {
    setCategories((current) =>
      current.map((category, currentCategoryIndex) =>
        currentCategoryIndex !== categoryIndex
          ? category
          : {
              ...category,
              criteria: category.criteria.map(
                (criterion, currentCriterionIndex) =>
                  currentCriterionIndex === criterionIndex
                    ? { ...criterion, ...patch }
                    : criterion
              ),
            }
      )
    );
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
      criteria: categories[categoryIndex]!.criteria.filter(
        (_, index) => index !== criterionIndex
      ),
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
      if (!response.ok)
        throw new Error(result.error || "Scorecard could not be published");
      router.refresh();
    } catch (publishError) {
      setError(
        publishError instanceof Error
          ? publishError.message
          : "Scorecard could not be published"
      );
    } finally {
      setSaving(false);
    }
  }

  async function updateComparability(
    payload:
      | { action: "combine"; versionIds: string[] }
      | { action: "revoke"; comparisonSetId: string }
  ) {
    setSavingComparability(true);
    setError("");
    try {
      const response = await fetch("/api/admin/scorecards/comparability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Comparability could not be updated");
      }
      setSelectedVersionIds([]);
      router.refresh();
    } catch (comparisonError) {
      setError(
        comparisonError instanceof Error
          ? comparisonError.message
          : "Comparability could not be updated"
      );
    } finally {
      setSavingComparability(false);
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
          <input
            id="scorecard-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </section>

      {categories.map((category, categoryIndex) => (
        <section className="scorecard-builder-category" key={categoryIndex}>
          <div className="builder-category-heading">
            <GripVertical size={16} />
            <input
              value={category.name}
              onChange={(event) =>
                updateCategory(categoryIndex, { name: event.target.value })
              }
              aria-label={`Category ${categoryIndex + 1} name`}
              placeholder="Category name"
            />
            <button
              className="icon-button"
              title="Remove category"
              aria-label="Remove category"
              disabled={categories.length === 1}
              onClick={() =>
                setCategories((current) =>
                  current.filter((_, index) => index !== categoryIndex)
                )
              }
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
                    onChange={(event) =>
                      updateCriterion(categoryIndex, criterionIndex, {
                        label: event.target.value,
                      })
                    }
                    placeholder="Criterion"
                    aria-label={`Criterion ${criterionIndex + 1}`}
                  />
                  <input
                    value={criterion.description}
                    onChange={(event) =>
                      updateCriterion(categoryIndex, criterionIndex, {
                        description: event.target.value,
                      })
                    }
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
                    onChange={(event) =>
                      updateCriterion(categoryIndex, criterionIndex, {
                        weight: Math.max(1, Number(event.target.value) || 1),
                      })
                    }
                  />
                </label>
                <label className="criterion-required-field">
                  <input
                    type="checkbox"
                    checked={criterion.required}
                    onChange={(event) =>
                      updateCriterion(categoryIndex, criterionIndex, {
                        required: event.target.checked,
                      })
                    }
                  />
                  <span>Required</span>
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
          <button
            className="button button-quiet"
            onClick={() => addCriterion(categoryIndex)}
          >
            <Plus size={14} /> Add criterion
          </button>
        </section>
      ))}

      <div className="scorecard-builder-actions">
        <button
          className="button button-secondary"
          onClick={() =>
            setCategories((current) => [
              ...current,
              {
                name: "New category",
                criteria: [
                  { label: "", description: "", weight: 1, required: true },
                ],
              },
            ])
          }
        >
          <Plus size={15} /> Add category
        </button>
        <button
          className="button button-primary"
          onClick={() => void publish()}
          disabled={saving}
        >
          {saving ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Save size={16} />
          )}
          Publish version
        </button>
      </div>

      {publishedVersions.length > 0 && (
        <section className="admin-section scorecard-comparability">
          <div className="section-heading">
            <div>
              <h2>Comparable versions</h2>
              <p>
                Scores stay segmented by version unless you explicitly combine
                materially equivalent versions.
              </p>
            </div>
          </div>

          <div className="version-selection">
            {publishedVersions.map((version) => {
              const activeSet = comparisonSets.find((comparisonSet) =>
                comparisonSet.versionIds.includes(version.id)
              );
              return (
                <label key={version.id}>
                  <input
                    type="checkbox"
                    checked={selectedVersionIds.includes(version.id)}
                    disabled={Boolean(activeSet) || savingComparability}
                    onChange={(event) =>
                      setSelectedVersionIds((current) =>
                        event.target.checked
                          ? [...current, version.id]
                          : current.filter((id) => id !== version.id)
                      )
                    }
                  />
                  <span>
                    Version {version.version} · {version.name}
                    {activeSet ? " · currently comparable" : ""}
                  </span>
                </label>
              );
            })}
          </div>

          <button
            className="button button-secondary"
            disabled={selectedVersionIds.length < 2 || savingComparability}
            onClick={() =>
              void updateComparability({
                action: "combine",
                versionIds: selectedVersionIds,
              })
            }
          >
            {savingComparability && <LoaderCircle className="spin" size={15} />}
            Mark selected versions comparable
          </button>

          {comparisonSets.map((comparisonSet) => {
            const versions = publishedVersions
              .filter((version) =>
                comparisonSet.versionIds.includes(version.id)
              )
              .map((version) => `v${version.version}`)
              .join(", ");
            return (
              <div className="comparison-set" key={comparisonSet.id}>
                <span>{versions} are combined for future analytics.</span>
                <button
                  className="button button-quiet"
                  disabled={savingComparability}
                  onClick={() =>
                    void updateComparability({
                      action: "revoke",
                      comparisonSetId: comparisonSet.id,
                    })
                  }
                >
                  Stop combining
                </button>
              </div>
            );
          })}
        </section>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
