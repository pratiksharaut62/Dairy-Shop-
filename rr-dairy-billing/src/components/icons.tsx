import type { CSSProperties } from 'react'
import * as L from 'lucide-react'

interface IconProps { size?: number; className?: string; style?: CSSProperties; title?: string }

/**
 * One place to fix the icon language: 16px, 1.75 stroke, currentColor.
 * Call sites stay terse — <Search /> — and override only when they must.
 */
const make = (C: L.LucideIcon) => {
  const Wrapped = ({ size = 16, className, style, title }: IconProps) => (
    <C size={size} strokeWidth={1.75} className={className} style={style} aria-hidden={!title} aria-label={title} />
  )
  Wrapped.displayName = `Icon(${C.displayName ?? 'lucide'})`
  return Wrapped
}

/* Navigation */
export const BillingIcon = make(L.ReceiptText)
export const BillsIcon = make(L.FileText)
export const CustomersIcon = make(L.Users)
export const InventoryIcon = make(L.Shirt)
export const StockIcon = make(L.Package)
export const PurchasesIcon = make(L.Truck)
export const LabelsIcon = make(L.Tags)
export const ExpensesIcon = make(L.Wallet)
export const ReportsIcon = make(L.ChartColumn)
export const DashboardIcon = make(L.LayoutDashboard)
export const SettingsIcon = make(L.Cog)

/* Actions */
export const Search = make(L.Search)
export const Printer = make(L.Printer)
export const Plus = make(L.Plus)
export const Minus = make(L.Minus)
export const Close = make(L.X)
export const Check = make(L.Check)
export const Warning = make(L.TriangleAlert)
export const Info = make(L.Info)
export const Download = make(L.Download)
export const Upload = make(L.Upload)
export const Refresh = make(L.RefreshCw)
export const Power = make(L.Power)
export const Menu = make(L.Menu)
export const MoreIcon = make(L.LayoutGrid)
export const Lock = make(L.Lock)
export const Backspace = make(L.Delete)
export const ArrowLeft = make(L.ArrowLeft)
export const ArrowRight = make(L.ArrowRight)
export const TrendUp = make(L.TrendingUp)
export const TrendDown = make(L.TrendingDown)

/* Domain */
export const ScanIcon = make(L.ScanLine)
export const ScanSearchIcon = make(L.ScanSearch)
export const UserIcon = make(L.User)
export const CashIcon = make(L.Banknote)
export const UpiIcon = make(L.Smartphone)
export const CardIcon = make(L.CreditCard)
export const CreditIcon = make(L.Ticket)
export const ParkedIcon = make(L.PauseCircle)
export const SupplierIcon = make(L.Store)
export const ReceiveIcon = make(L.PackagePlus)
export const AuditIcon = make(L.ClipboardList)
export const HistoryIcon = make(L.History)
export const InboxIcon = make(L.Inbox)
export const CheckCircle = make(L.CircleCheckBig)
export const AlertIcon = make(L.CircleAlert)
export const CalendarIcon = make(L.Calendar)
export const CoinsIcon = make(L.Coins)
export const RupeeIcon = make(L.IndianRupee)
export const BoxesIcon = make(L.Boxes)
export const PercentIcon = make(L.Percent)
export const RotateIcon = make(L.RotateCcw)
export const TrashIcon = make(L.Trash2)
export const PencilIcon = make(L.Pencil)
export const FileTextIcon = make(L.FileText)
export const ChevronDown = make(L.ChevronDown)
