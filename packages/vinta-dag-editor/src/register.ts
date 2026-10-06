/**
 * Defining the element is a side effect, so it lives in its own module: a host
 * that wants a different tag name — two versions on one page, say — imports
 * `defineDagEditor` from the root and never loads this.
 */

import { defineDagEditor } from './define'

defineDagEditor()
