import { useState } from 'react'
import { useAccount, ACCOUNT_COLOURS, colourOf, type Account } from '../lib/AccountContext'
import { updateAccount, deleteAccountForGood } from '../lib/repository'
import { moneyFormatter } from '../lib/money'
import Sheet, { reportError } from './Sheet'
import { TextField } from './controls'
import { useToast } from './toastContext'
import AcctDot from './AcctDot'

/** Settings › Accounts (Journey 11, mock pp-release8-mockA): the accounts in use,
 *  then Archived, which opens in place. Tap one for its sheet. */
export default function AccountsPage({ onAddAccount }: { onAddAccount: () => void }) {
  const { allAccounts, activeAccount } = useAccount()
  const [open, setOpen] = useState<string | null>(null)
  const [showArch, setShowArch] = useState(false)
  const live = allAccounts.filter(a => !a.archived), arch = allAccounts.filter(a => a.archived)
  const idx = (a: Account) => allAccounts.indexOf(a)
  const acct = allAccounts.find(a => a.id === open)

  return (
    <div className="rw-page">
      <div className="rw-page-head rw-acc-head">
        <h1 className="rw-page-title">Accounts</h1>
        <button type="button" className="rw-addb" onClick={onAddAccount}>+ Add</button>
      </div>
      <div className="rw-group rw-acc-list">
        {live.map(a => (
          <button key={a.id} type="button" className="rw-row" onClick={() => setOpen(a.id)}>
            <AcctDot account={a} i={idx(a)} />
            <div className="rw-tx">
              <div className="rw-row-name">{a.name}</div>
              <div className="rw-sub">{a.currency_code} · floor {moneyFormatter(a.currency_code)(a.safety_floor_cents, false)}{a.id === activeAccount?.id ? ' · open now' : ''}</div>
            </div>
            <span className="rw-chev">›</span>
          </button>
        ))}
      </div>
      {arch.length > 0 && <>
        <div role="heading" aria-level={2} className="rw-section" />
        <div className="rw-group">
          <button type="button" className="rw-row" aria-expanded={showArch} onClick={() => setShowArch(!showArch)}>
            <div className="rw-tx"><div className="rw-row-name">Archived ({arch.length})</div><div className="rw-sub">Hidden from More · history kept</div></div>
            <span className={`rw-chev rw-turn${showArch ? ' on' : ''}`}>›</span>
          </button>
          {showArch && arch.map(a => (
            <button key={a.id} type="button" className="rw-row" onClick={() => setOpen(a.id)}>
              <AcctDot account={a} i={idx(a)} />
              <div className="rw-tx"><div className="rw-row-name rw-muted">{a.name}</div><div className="rw-sub">{a.currency_code}</div></div>
              <span className="rw-chev">›</span>
            </button>
          ))}
        </div>
      </>}
      {acct && <AccountSheet account={acct} onClose={() => setOpen(null)} />}
    </div>
  )
}

/** One account: name, colour, the locked currency, then archive / restore / delete for good. */
export function AccountSheet({ account: a, onClose }: { account: Account; onClose: () => void }) {
  const { allAccounts, reloadAccounts } = useAccount()
  const toast = useToast()
  const i = allAccounts.indexOf(a)
  const [name, setName] = useState(a.name)
  const [col, setCol] = useState(colourOf(a, i))
  const [del, setDel] = useState(false), [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const live = allAccounts.filter(x => !x.archived)
  const only = !a.archived && live.length < 2
  // Another account in use with this colour: shown, never blocked.
  const usedBy: Record<number, string> = {}
  live.forEach(x => { if (x.id !== a.id) usedBy[colourOf(x, allAccounts.indexOf(x))] ??= x.name })
  const changed = (!!name.trim() && name.trim() !== a.name) || col !== colourOf(a, i)

  async function act(f: () => Promise<void>, fail: string) {
    setBusy(true)
    try { await f() } catch (e) { reportError(fail, e) } finally { setBusy(false) }
  }
  const save = () => act(async () => {
    await updateAccount(a.id, { name: name.trim() || a.name, colour: col })
    await reloadAccounts(); onClose(); toast(`${name.trim() || a.name} saved`)
  }, 'That didn’t save.')
  const setArchived = (on: boolean) => act(async () => {
    await updateAccount(a.id, { archived: on })
    await reloadAccounts(); onClose()
    if (on) toast(`${a.name} archived`, { lasting: true, undo: async () => { await updateAccount(a.id, { archived: false }); await reloadAccounts() } })
    else toast(`${a.name} restored`)
  }, on ? 'That wasn’t archived.' : 'That wasn’t restored.')
  const deleteIt = () => act(async () => {
    await deleteAccountForGood(a.id)
    await reloadAccounts(); onClose(); toast(`${a.name} deleted`)
  }, 'That wasn’t deleted.')

  if (del) return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h">
        <div><h2 className="rw-sheet-title">Delete {a.name} for good?</h2>
          <div className="rw-sd">Its cycles, expenses and history go too. Other accounts aren’t touched. This can’t be undone.</div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="rw-card">
        <div className="rw-lab rw-lab-0">Type {a.name} to confirm</div>
        <TextField label={`Type ${a.name} to confirm`} value={typed} onChange={setTyped} placeholder={a.name} />
      </div>
      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={() => setDel(false)}>Back</button>
        <button type="button" className="rw-cta dang" disabled={busy || typed.trim() !== a.name} onClick={deleteIt}>{busy ? 'Deleting…' : 'Delete for good'}</button>
      </div>
    </Sheet>
  )

  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h">
        <div className="rw-sh-t"><AcctDot account={{ colour: col, name: a.name }} name={name || a.name} size="lg" />
          <div><h2 className="rw-sheet-title">{a.name}</h2><div className="rw-sd">{a.currency_code}{a.archived ? ' · archived' : ''}</div></div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="rw-card">
        <div className="rw-lab rw-lab-0">Name</div>
        <TextField label="Name" value={name} onChange={setName} />
        <div className="rw-lab">Colour</div>
        <div className="rw-swatches" role="radiogroup" aria-label="Colour">
          {ACCOUNT_COLOURS.map((c, k) => (
            <button key={c} type="button" role="radio" aria-checked={col === k}
              aria-label={`${c}${usedBy[k] ? `, also ${usedBy[k]}` : ''}`}
              className={`rw-swatch rw-acct-${k}${col === k ? ' on' : ''}`} onClick={() => setCol(k)}>
              {col === k ? '✓' : usedBy[k] ? '·' : ''}
            </button>
          ))}
        </div>
        <div className="rw-hint">{usedBy[col] ? `${usedBy[col]} uses this colour too.` : 'A dot means another account uses it.'}</div>
      </div>
      <div className="rw-group flush rw-acc-acts">
        <div className="rw-row static">
          <div className="rw-tx"><div className="rw-row-name">Currency</div><div className="rw-sub">Set when the account was made</div></div>
          <span className="rw-rval">{a.currency_code}</span>
        </div>
        {a.archived ? <>
          <button type="button" className="rw-row" disabled={busy} onClick={() => setArchived(false)}>
            <div className="rw-tx"><div className="rw-row-name">Restore {a.name}</div><div className="rw-sub">Back in More</div></div>
          </button>
          <button type="button" className="rw-row" disabled={busy} onClick={() => setDel(true)}>
            <div className="rw-tx"><div className="rw-row-name rw-danger">Delete for good</div><div className="rw-sub">Type its name to confirm</div></div>
          </button>
        </> : only ? (
          <div className="rw-row static"><div className="rw-tx"><div className="rw-sub">Your only account can’t be archived.</div></div></div>
        ) : (
          <button type="button" className="rw-row" disabled={busy} onClick={() => setArchived(true)}>
            <div className="rw-tx"><div className="rw-row-name rw-danger">Archive {a.name}</div><div className="rw-sub">Hidden from More · history kept</div></div>
          </button>
        )}
      </div>
      <div className="rw-ctas">
        {changed
          ? <><button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
              <button type="button" className="rw-cta" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>
          : <button type="button" className="rw-cta" onClick={onClose}>Close</button>}
      </div>
    </Sheet>
  )
}
