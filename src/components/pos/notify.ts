import { toast, type ExternalToast } from "sonner";

/** Toasts at the top of the terminal, clear of the Send and Pay buttons. */
const at = (o?: ExternalToast): ExternalToast => ({ position: "top-center", ...o });

export const notify = {
  success: (msg: string, o?: ExternalToast) => toast.success(msg, at(o)),
  warning: (msg: string, o?: ExternalToast) => toast.warning(msg, at(o)),
  error: (msg: string, o?: ExternalToast) => toast.error(msg, at(o)),
};
