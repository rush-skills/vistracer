import { useEffect } from "react";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";

export const useTracerouteSubscription = () => {
  const handleProgress = useTracerouteStore((state) => state.handleProgress);

  useEffect(() => {
    if (!window.visTracer?.subscribeTracerouteProgress) {
      return;
    }

    const unsubscribe = window.visTracer.subscribeTracerouteProgress(handleProgress);
    return () => {
      unsubscribe?.();
    };
  }, [handleProgress]);
};
