/** One right slot; hiding always releases focus before applying inert. */
export class RightSidebar {
  constructor(onChange, beforeChange) {
    this.onChange = onChange;
    this.beforeChange = beforeChange;
    this.shell = document.getElementById('right-sidebar');
    this.backdrop = document.getElementById('right-sidebar-backdrop');
    this.bodies = {
      agents: document.getElementById('agents-sidebar'),
      files: document.getElementById('file-sidebar'),
    };
    this.triggers = {
      agents: document.getElementById('agents-sidebar-toggle'),
      files: document.getElementById('file-sidebar-toggle'),
    };
    this.mode = localStorage.getItem('tau-right-sidebar-mode') === 'files' ? 'files' : 'agents';
    this.open = false;
    this.restored = false;
    for (const mode of ['agents', 'files']) {
      this.triggers[mode].addEventListener('click', () => this.toggle(mode));
      document.getElementById(mode === 'agents' ? 'agents-sidebar-close' : 'file-sidebar-close')
        .addEventListener('click', () => this.close());
    }
    this.backdrop.addEventListener('click', () => this.close());
    document.addEventListener('keydown', event => {
      if (!this.open || innerWidth > 768 || event.key !== 'Tab' ||
          document.querySelector('dialog[open], #dialog-container:not(.hidden)')) return;
      const controls = [...this.bodies[this.mode].querySelectorAll(
        'button:not([disabled]), summary, a[href], input:not([disabled]), [tabindex="0"]',
      )].filter(control => control.checkVisibility());
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    this.render();
  }

  restore() {
    if (this.restored) return;
    this.restored = true;
    if (['agents', 'files'].includes(localStorage.getItem('tau-right-sidebar-mode')) &&
        localStorage.getItem('tau-right-sidebar-open') === 'open') {
      this.beforeChange();
      this.open = true;
      this.render();
    }
  }

  toggle(mode) {
    if (this.open && this.mode === mode) {
      this.close();
      return;
    }
    this.beforeChange();
    if (this.shell.contains(document.activeElement)) this.triggers[mode].focus({ preventScroll: true });
    this.mode = mode;
    this.open = true;
    localStorage.setItem('tau-right-sidebar-mode', mode);
    localStorage.setItem('tau-right-sidebar-open', 'open');
    this.render();
    // A phone overlay covers its trigger; put keyboard focus inside the panel.
    if (innerWidth <= 768) {
      document.getElementById(mode === 'agents' ? 'agents-sidebar-close' : 'file-sidebar-close').focus();
    }
  }

  close(persist = true) {
    this.beforeChange();
    if (this.open) this.triggers[this.mode].focus({ preventScroll: true });
    this.open = false;
    if (persist) localStorage.setItem('tau-right-sidebar-open', 'closed');
    this.render();
  }

  render() {
    this.shell.inert = !this.open;
    this.shell.classList.toggle('collapsed', !this.open);
    for (const mode of ['agents', 'files']) {
      const active = this.open && this.mode === mode;
      this.bodies[mode].inert = !active;
      this.bodies[mode].classList.toggle('collapsed', !active);
      this.triggers[mode].setAttribute('aria-expanded', String(active));
      this.triggers[mode].classList.toggle('active', active);
    }
    this.backdrop.hidden = !this.open;
    this.onChange(this.open ? this.mode : null);
  }
}
