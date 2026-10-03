import { toast, type ExternalToast } from "sonner";

/** The terminal's own toaster (mounted by /pos), placed clear of the header, Send/Pay and the order actions. */
export const POS_TOASTER = "pos";

const at = (o?: ExternalToast): ExternalToast => ({ toasterId: POS_TOASTER, ...o });

export const notify = {
  success: (msg: string, o?: ExternalToast) => toast.success(msg, at(o)),
  warning: (msg: string, o?: ExternalToast) => toast.warning(msg, at(o)),
  error: (msg: string, o?: ExternalToast) => toast.error(msg, at(o)),
};
