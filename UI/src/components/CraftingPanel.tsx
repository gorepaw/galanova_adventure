import React, { useState } from 'react'
import ItemTooltip, { buildTipItem } from './ItemTooltip.jsx'

function tipPos(e) {
  const x = e.clientX + 14 + 240 > window.innerWidth ? e.clientX - 254 : e.clientX + 14
  return { x, y: e.clientY - 8 }
}

function RecipeRow({ recipe, itemCatalog, onCraft, loading }) {
  const [tip, setTip] = useState(null)

  return (
    <div className={`recipe-row ${recipe.matsOk ? '' : 'recipe-mats-missing'}`}>
      <div className="recipe-top">
        <span className="recipe-name">{recipe.name}</span>
        <span
          className="recipe-output"
          onMouseEnter={(e) => setTip({ item: buildTipItem(recipe.output.itemId, itemCatalog), ...tipPos(e) })}
          onMouseMove={(e) => setTip(prev => prev ? { ...prev, ...tipPos(e) } : prev)}
          onMouseLeave={() => setTip(null)}
        >
          → {recipe.output.qty}× {itemCatalog[recipe.output.itemId]?.name || recipe.output.itemId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
        </span>
        {recipe.requiredProfession && (
          <span className="recipe-prof">
            {recipe.crafterName} · {recipe.requiredProfession}
            {recipe.minSkillLevel > 0 ? ` ${recipe.minSkillLevel}+` : ''}
          </span>
        )}
      </div>
      <div className="recipe-bottom">
        <div className="recipe-mats">
          {recipe.inputs.map(inp => {
            const ok = inp.have >= inp.qty
            return (
              <span
                key={inp.itemId}
                className={`mat-tag ${ok ? 'mat-ok' : 'mat-short'}`}
                onMouseEnter={(e) => setTip({
                  item: buildTipItem(inp.itemId, itemCatalog, { note: `Have: ${inp.have} / Need: ${inp.qty}` }),
                  ...tipPos(e),
                })}
                onMouseMove={(e) => setTip(prev => prev ? { ...prev, ...tipPos(e) } : prev)}
                onMouseLeave={() => setTip(null)}
              >
                {inp.qty}× {itemCatalog[inp.itemId]?.name || inp.itemId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                <span className="mat-have">({inp.have})</span>
              </span>
            )
          })}
        </div>
        <button
          className="btn btn-sm btn-craft"
          onClick={() => onCraft(recipe.id)}
          disabled={!recipe.matsOk || loading}
          title={recipe.matsOk ? `Craft ${recipe.name}` : 'Missing materials'}
        >
          Craft
        </button>
      </div>
      {tip && <ItemTooltip item={tip.item} x={tip.x} y={tip.y} />}
    </div>
  )
}

export default function CraftingPanel({ recipes, itemCatalog, onCraft, loading }) {
  if (!recipes || recipes.length === 0) {
    return (
      <div className="crafting-panel">
        <div className="panel-empty">
          No recipes available — party needs a profession to unlock crafting.
        </div>
      </div>
    )
  }

  const craftable = recipes.filter(r => r.matsOk)
  const locked    = recipes.filter(r => !r.matsOk)

  return (
    <div className="crafting-panel">
      {craftable.length > 0 && (
        <section className="recipe-section">
          <div className="recipe-section-label">Ready to craft ({craftable.length})</div>
          {craftable.map(r => (
            <RecipeRow key={r.id} recipe={r} itemCatalog={itemCatalog} onCraft={onCraft} loading={loading} />
          ))}
        </section>
      )}
      {locked.length > 0 && (
        <section className="recipe-section">
          <div className="recipe-section-label">Missing materials ({locked.length})</div>
          {locked.map(r => (
            <RecipeRow key={r.id} recipe={r} itemCatalog={itemCatalog} onCraft={onCraft} loading={loading} />
          ))}
        </section>
      )}
    </div>
  )
}
