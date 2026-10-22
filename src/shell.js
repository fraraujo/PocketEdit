        // -----------------------------------------------------
        // HOVER TO FOCUS AND SCROLL LOGIC
        // -----------------------------------------------------
        let currentlyHoveredControl = null;

        // -----------------------------------------------------
        // NON-BLOCKING NOTIFICATIONS (used instead of alert())
        // -----------------------------------------------------
        function showToast(message, type = 'info', timeoutMs = 4000) {
            const container = document.getElementById('toast-container');
            if (!container) {
                console.warn(`[${type.toUpperCase()}] ${message}`);
                return;
            }

            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
            toast.textContent = message;
            container.appendChild(toast);

            const remove = () => {
                toast.classList.add('leaving');
                setTimeout(() => toast.remove(), 250);
            };
            setTimeout(remove, timeoutMs);

            // Dismiss on click, in case the user wants it gone sooner.
            toast.addEventListener('click', remove, { once: true });
        }

        // Helper function to dispatch 'input' AND 'change' events to simulate native behavior
        function triggerControlUpdate(element) {
            const inputEvent = new Event('input', { bubbles: true });
            element.dispatchEvent(inputEvent);
            const changeEvent = new Event('change', { bubbles: true });
            element.dispatchEvent(changeEvent);
        }

        document.addEventListener('mouseover', (e) => {
            const validTarget = e.target instanceof Element ? e.target.closest('.slider, .dropdown-select, .toggle-switch, .chain-module') : null;
            if (validTarget && !validTarget.disabled && !validTarget.classList.contains('locked')) {
                currentlyHoveredControl = validTarget;
                const row = validTarget.closest('.control-row');
                if (row) row.classList.add('hover-focus');
                else if (validTarget.classList.contains('chain-module')) validTarget.classList.add('hover-focus');
            }
        });

        document.addEventListener('mouseout', (e) => {
            if (currentlyHoveredControl) {
                const relatedTarget = e.relatedTarget;
                const stillInside = relatedTarget instanceof Node && currentlyHoveredControl.contains(relatedTarget);
                if (!stillInside) {
                    const row = currentlyHoveredControl.closest('.control-row');
                    if (row) row.classList.remove('hover-focus');
                    else if (currentlyHoveredControl.classList.contains('chain-module')) currentlyHoveredControl.classList.remove('hover-focus');
                    currentlyHoveredControl = null;
                }
            }
        });

        // Intercept Wheel
        document.addEventListener('wheel', (e) => {
            if (!currentlyHoveredControl) return;

            // Controls are re-created when presets/effect types change. If the hovered
            // control was detached in the meantime, forget it; otherwise preventDefault()
            // below would keep swallowing page scrolling for the whole document.
            if (!currentlyHoveredControl.isConnected || currentlyHoveredControl.classList.contains('locked')) {
                currentlyHoveredControl = null;
                return;
            }

            e.preventDefault(); // Prevent default scroll
            const direction = e.deltaY > 0 ? -1 : 1; 

            if (currentlyHoveredControl.classList.contains('slider')) {
                const slider = currentlyHoveredControl;
                let step = parseFloat(slider.step) || 1;
                const min = parseFloat(slider.min) || 0;
                const max = parseFloat(slider.max) || 100;
                
                // Allow shift key for finer control if available, but currently step logic works
                // if (e.shiftKey) step /= 10; 

                let newVal = parseFloat(slider.value) + (direction * step);

                if (newVal > max) newVal = max;
                if (newVal < min) newVal = min;

                // Format correctly relative to step count to avoid floating point issues like 0.300000004
                const stepStr = String(step);
                const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
                newVal = parseFloat(newVal.toFixed(decimals));

                if (slider.value !== String(newVal)) {
                     slider.value = newVal;
                     triggerControlUpdate(slider);
                }
            }
            else if (currentlyHoveredControl.classList.contains('dropdown-select')) {
                const select = currentlyHoveredControl;
                if (select.options.length === 0) return;

                let selectedIndex = select.selectedIndex - direction; // Same reverse logic
                if (selectedIndex >= select.options.length) selectedIndex = select.options.length - 1;
                if (selectedIndex < 0) selectedIndex = 0;

                if (select.selectedIndex !== selectedIndex) {
                    select.selectedIndex = selectedIndex;
                    triggerControlUpdate(select);
                }
            }
            else if (currentlyHoveredControl.classList.contains('toggle-switch') || currentlyHoveredControl.classList.contains('chain-module')) {
                const toggle = currentlyHoveredControl.classList.contains('chain-module') ? 
                    currentlyHoveredControl.querySelector('.module-power') : currentlyHoveredControl;
                
                if (toggle) {
                    // Prevent rapid flipping by recording last flip timestamp
                    const now = Date.now();
                    const lastFlip = parseInt(toggle.dataset.lastWheelFlip || "0");
                    if (now - lastFlip > 200) { 
                         toggle.click(); 
                         toggle.dataset.lastWheelFlip = now;
                    }
                }
            }
        }, { passive: false }); 

        // Intercept Arrows (Keyboard)
        document.addEventListener('keydown', (e) => {
            if (!currentlyHoveredControl) return;
            // Do not act on a control that was replaced by a UI rebuild.
            if (!currentlyHoveredControl.isConnected) { currentlyHoveredControl = null; return; }
            // Ignore if user is actively typing in a native input box somewhere else
            if (document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'number') {
                return;
            }

            let direction = 0;
            if (e.key === 'ArrowUp' || e.key === 'ArrowRight') direction = 1;
            if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') direction = -1;

            if (direction !== 0) {
                e.preventDefault(); // Prevent page scroll
                
                if (currentlyHoveredControl.classList.contains('slider')) {
                    const slider = currentlyHoveredControl;
                    let step = parseFloat(slider.step) || 1;
                    const min = parseFloat(slider.min) || 0;
                    const max = parseFloat(slider.max) || 100;
                    
                    let newVal = parseFloat(slider.value) + (direction * step);

                    if (newVal > max) newVal = max;
                    if (newVal < min) newVal = min;

                    const stepStr = String(step);
                    const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
                    newVal = parseFloat(newVal.toFixed(decimals));

                    if (slider.value !== String(newVal)) {
                         slider.value = newVal;
                         triggerControlUpdate(slider);
                    }
                } 
                else if (currentlyHoveredControl.classList.contains('dropdown-select')) {
                     const select = currentlyHoveredControl;
                     let selectedIndex = select.selectedIndex - direction; 
                     if (selectedIndex >= select.options.length) selectedIndex = select.options.length - 1;
                     if (selectedIndex < 0) selectedIndex = 0;

                     if (select.selectedIndex !== selectedIndex) {
                        select.selectedIndex = selectedIndex;
                        triggerControlUpdate(select);
                     }
                } 
                else if (currentlyHoveredControl.classList.contains('toggle-switch') || currentlyHoveredControl.classList.contains('chain-module')) {
                    // Direction doesn't matter for toggles on key press, just flip it
                    const toggle = currentlyHoveredControl.classList.contains('chain-module') ? 
                        currentlyHoveredControl.querySelector('.module-power') : currentlyHoveredControl;
                    if (toggle) {
                        const now = Date.now();
                        const lastFlip = parseInt(toggle.dataset.lastKeyFlip || "0");
                        if (now - lastFlip > 200) { 
                             toggle.click(); 
                             toggle.dataset.lastKeyFlip = now;
                        }
                    }
                }
            }
        });

        // Prevent exact default navigation on mousedown for buttons 3 and 4
        document.addEventListener('mousedown', (e) => {
            if (currentlyHoveredControl && (e.button === 3 || e.button === 4)) {
                e.preventDefault(); 
            }
        });

        // Intercept Mouse 4/5 on mouseup
        document.addEventListener('mouseup', (e) => {
            if (!currentlyHoveredControl) return;
            if (!currentlyHoveredControl.isConnected) { currentlyHoveredControl = null; return; }

            let direction = 0;
            if (e.button === 3) direction = -1; // Mouse 4 (Backward)
            if (e.button === 4) direction = 1;  // Mouse 5 (Forward)

            if (direction !== 0) {
                e.preventDefault();
                
                if (currentlyHoveredControl.classList.contains('slider')) {
                    const slider = currentlyHoveredControl;
                    let step = parseFloat(slider.step) || 1;
                    const min = parseFloat(slider.min) || 0;
                    const max = parseFloat(slider.max) || 100;
                    let newVal = parseFloat(slider.value) + (direction * step);

                    if (newVal > max) newVal = max;
                    if (newVal < min) newVal = min;

                    const stepStr = String(step);
                    const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
                    newVal = parseFloat(newVal.toFixed(decimals));

                    if (slider.value !== String(newVal)) {
                         slider.value = newVal;
                         triggerControlUpdate(slider);
                    }
                } 
                else if (currentlyHoveredControl.classList.contains('dropdown-select')) {
                    const select = currentlyHoveredControl;
                    let idx = select.selectedIndex - direction;
                    if (idx < 0) idx = 0;
                    if (idx >= select.options.length) idx = select.options.length - 1;

                    if (select.selectedIndex !== idx) {
                        select.selectedIndex = idx;
                        triggerControlUpdate(select);
                    }
                } 
                else if (currentlyHoveredControl.classList.contains('toggle-switch') || currentlyHoveredControl.classList.contains('chain-module')) {
                    const toggle = currentlyHoveredControl.classList.contains('chain-module') ? 
                        currentlyHoveredControl.querySelector('.module-power') : currentlyHoveredControl;
                    if (toggle) toggle.click();
                }
            }
        });

        document.addEventListener('DOMContentLoaded', () => {
            window.bleEditor = new SonicakeBLEEditor();
            window.bleEditor.startEditor(); // Automatically start the editor on page load
        });
