// Lazy entry point for the code sub-view. Importing this module never pulls
// in the editor / terminal / minimap bundle — those load on first Code-view
// entry, keeping the default bundle small. FullLayout wraps the lazy
// component in a Suspense boundary.
import { lazy } from 'react';

export const CodeView = lazy(() => import('./CodeView.js'));
