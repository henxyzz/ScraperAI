import { CheckCircle, XCircle, AlertTriangle, Info, X } from "lucide-react";
import { useStore } from "../store";

const ICONS = {
  success: CheckCircle,
  error:   XCircle,
  warn:    AlertTriangle,
  info:    Info,
};

export function ToastContainer() {
  const { toasts, removeToast } = useStore();

  if (!toasts.length) return null;

  return (
    <div className="toast-container">
      {toasts.map(t => {
        const Icon = ICONS[t.type];
        return (
          <div key={t.id} className={`toast ${t.type}`}>
            <Icon size={16} />
            <span>{t.msg}</span>
            <button className="toast-close" onClick={() => removeToast(t.id)}>
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
